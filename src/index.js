/**
 * Creative Dashboard — Cloudflare Worker (Multi-Kempen)
 *
 * Routes:
 *   GET  /api/campaigns         → senarai kempen
 *   POST /api/campaigns         → buat kempen baru
 *   POST /api/upload/fb         → upload FB Ads CSV
 *   POST /api/upload/onpay      → upload Onpay CSV
 *   POST /api/upload/videos     → upload Video Links CSV
 *   GET  /api/metrics           → data gabungan (filter: ?campaign_id=)
 *   GET  /api/donations         → senarai donation (filter: ?campaign_id=)
 *   POST /webhook/onpay         → Onpay real-time webhook
 */

// ─── CORS ─────────────────────────────────────────────────────────────────────
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResp(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const c = corsHeaders(env);

    if (request.method === 'OPTIONS') return new Response(null, { headers: c });

    try {
      if (pathname === '/api/campaigns' && request.method === 'GET')
        return await getCampaigns(env, c);

      if (pathname === '/api/campaigns' && request.method === 'POST')
        return await createCampaign(request, env, c);

      if (pathname === '/api/upload/fb' && request.method === 'POST')
        return await uploadFB(request, env, c);

      if (pathname === '/api/upload/onpay' && request.method === 'POST')
        return await uploadOnpay(request, env, c);

      if (pathname === '/api/upload/videos' && request.method === 'POST')
        return await uploadVideos(request, env, c);

      if (pathname === '/api/metrics' && request.method === 'GET')
        return await getMetrics(request, env, c);

      if (pathname === '/api/donations' && request.method === 'GET')
        return await getDonations(request, env, c);

      if (pathname === '/api/logs' && request.method === 'GET')
        return await getLogs(request, env, c);

      if (pathname === '/api/snapshots' && request.method === 'GET')
        return await getSnapshots(request, env, c);

      if (pathname === '/api/rollback' && request.method === 'POST')
        return await rollbackFB(request, env, c);

      if (pathname === '/webhook/onpay' && request.method === 'POST')
        return await handleOnpayWebhook(request, env, c);

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return jsonResp({ ok: false, error: err.message }, 500, c);
    }
  },
};

// ─── GET CAMPAIGNS ────────────────────────────────────────────────────────────
async function getCampaigns(env, c) {
  const result = await env.DB.prepare(
    'SELECT * FROM campaigns ORDER BY created_at ASC'
  ).all();
  return jsonResp({ ok: true, campaigns: result.results }, 200, c);
}

// ─── CREATE CAMPAIGN ──────────────────────────────────────────────────────────
async function createCampaign(request, env, c) {
  const { id, name } = await request.json();
  if (!id || !name)
    return jsonResp({ ok: false, error: 'id dan name diperlukan' }, 400, c);
  if (!/^[a-z0-9-]+$/.test(id))
    return jsonResp({ ok: false, error: 'id: huruf kecil, nombor, dan tanda - sahaja' }, 400, c);

  await env.DB.prepare(
    'INSERT OR IGNORE INTO campaigns (id, name) VALUES (?, ?)'
  ).bind(id, name).run();

  return jsonResp({ ok: true, id, name }, 200, c);
}

// ─── UPLOAD FB ADS CSV ────────────────────────────────────────────────────────
async function uploadFB(request, env, c) {
  const formData   = await request.formData();
  const file       = formData.get('file');
  const campaignId = formData.get('campaign_id') || 'rumah-padi';
  if (!file) return jsonResp({ ok: false, error: 'Tiada fail' }, 400, c);

  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) return jsonResp({ ok: false, error: 'CSV kosong' }, 400, c);

  // Pastikan kempen wujud
  await env.DB.prepare(
    'INSERT OR IGNORE INTO campaigns (id, name) VALUES (?, ?)'
  ).bind(campaignId, campaignId).run();

  // Snapshot data semasa sebelum upload (untuk rollback)
  const snapshotId = Date.now().toString();
  const existing   = await env.DB.prepare(
    'SELECT * FROM fb_ads WHERE campaign_id = ?'
  ).bind(campaignId).all();

  for (const row of existing.results) {
    await env.DB.prepare(`
      INSERT INTO fb_ads_snapshots
        (snapshot_id, campaign_id, ad_name, spend, impressions, reach, ctr,
         purchases, cost_per_result, purchase_roas, lpv, cost_per_lpv,
         hook_rate, cpc, link_clicks, frequency, cpm, date_start, date_stop)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      snapshotId, row.campaign_id, row.ad_name,
      row.spend, row.impressions, row.reach, row.ctr,
      row.purchases, row.cost_per_result, row.purchase_roas,
      row.lpv, row.cost_per_lpv, row.hook_rate,
      row.cpc, row.link_clicks, row.frequency, row.cpm,
      row.date_start, row.date_stop
    ).run();
  }

  // Buang snapshot lama — simpan 5 terkini sahaja
  const oldSnaps = await env.DB.prepare(`
    SELECT DISTINCT snapshot_id FROM fb_ads_snapshots
    WHERE campaign_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 5
  `).bind(campaignId).all();
  for (const s of oldSnaps.results) {
    await env.DB.prepare(
      'DELETE FROM fb_ads_snapshots WHERE snapshot_id = ?'
    ).bind(s.snapshot_id).run();
  }

  let upserted = 0;
  for (const row of rows) {
    const adName = row['Ad name'] || row['ad_name'];
    if (!adName) continue;

    const spend      = parseFloat(row['Amount spent (MYR)'] || row['spend'] || 0);
    const impr       = parseInt(row['Impressions'] || 0);
    const reach      = parseInt(row['Reach'] || 0);
    const ctr        = parseFloat(row['CTR (all)'] || row['ctr'] || 0);
    const hookRate   = parseFloat(row['Hook Hold Rate'] || 0);
    const lpv        = parseInt(row['Landing page views'] || 0);
    const cplpv      = parseFloat(row['Cost per landing page view'] || 0);
    const roas       = parseFloat(row['Purchase ROAS (return on ad spend)'] || 0);
    const purchases  = parseInt(row['Results'] || row['Purchases'] || 0);
    const costRes    = parseFloat(row['Cost per result'] || 0);
    const cpc        = parseFloat(row['CPC (cost per link click)'] || 0);
    const linkClicks = cpc > 0 ? Math.round(spend / cpc) : 0;
    const frequency  = reach > 0 ? impr / reach : 0;
    const cpm        = impr > 0 ? spend / impr * 1000 : 0;
    const dateStart  = row['Reporting starts'] || row['date_start'] || '';
    const dateStop   = row['Reporting ends']   || row['date_stop']  || '';
    const campaign   = row['Campaign name'] || '';
    const adset      = row['Ad set name']   || '';

    // Incremental (mingguan): tambah angka baru ke atas yang sedia ada
    // Rate metrics dikira semula dari totals terkumpul
    await env.DB.prepare(`
      INSERT INTO fb_ads
        (campaign_id, ad_name, campaign_name, adset_name,
         spend, impressions, reach, ctr,
         purchases, cost_per_result, purchase_roas,
         lpv, cost_per_lpv, hook_rate,
         cpc, link_clicks, frequency, cpm,
         date_start, date_stop, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (campaign_id, ad_name) DO UPDATE SET
        campaign_name   = excluded.campaign_name,
        adset_name      = excluded.adset_name,
        spend           = spend + excluded.spend,
        impressions     = impressions + excluded.impressions,
        reach           = reach + excluded.reach,
        purchases       = purchases + excluded.purchases,
        lpv             = lpv + excluded.lpv,
        link_clicks     = link_clicks + excluded.link_clicks,
        -- Kira semula rates dari totals baru
        ctr             = CASE WHEN (impressions + excluded.impressions) > 0
                            THEN (link_clicks + excluded.link_clicks) * 100.0 / (impressions + excluded.impressions)
                            ELSE 0 END,
        cpm             = CASE WHEN (impressions + excluded.impressions) > 0
                            THEN (spend + excluded.spend) * 1000.0 / (impressions + excluded.impressions)
                            ELSE 0 END,
        cpc             = CASE WHEN (link_clicks + excluded.link_clicks) > 0
                            THEN (spend + excluded.spend) / (link_clicks + excluded.link_clicks)
                            ELSE 0 END,
        cost_per_lpv    = CASE WHEN (lpv + excluded.lpv) > 0
                            THEN (spend + excluded.spend) / (lpv + excluded.lpv)
                            ELSE 0 END,
        cost_per_result = CASE WHEN (purchases + excluded.purchases) > 0
                            THEN (spend + excluded.spend) / (purchases + excluded.purchases)
                            ELSE 0 END,
        frequency       = CASE WHEN (reach + excluded.reach) > 0
                            THEN (impressions + excluded.impressions) * 1.0 / (reach + excluded.reach)
                            ELSE 0 END,
        -- Hook rate: weighted average ikut impressions
        hook_rate       = CASE WHEN (impressions + excluded.impressions) > 0
                            THEN (hook_rate * impressions + excluded.hook_rate * excluded.impressions)
                                 / (impressions + excluded.impressions)
                            ELSE 0 END,
        purchase_roas   = excluded.purchase_roas,
        date_start      = CASE WHEN date_start < excluded.date_start THEN date_start ELSE excluded.date_start END,
        date_stop       = excluded.date_stop,
        uploaded_at     = datetime('now')
    `).bind(
      campaignId, adName, campaign, adset,
      spend, impr, reach, ctr,
      purchases, costRes, roas,
      lpv, cplpv, hookRate,
      cpc, linkClicks, frequency, cpm,
      dateStart, dateStop
    ).run();

    upserted++;
  }

  // Log upload (simpan snapshotId untuk rollback)
  const totalSpend = rows.reduce((s, r) => s + parseFloat(r['Amount spent (MYR)'] || r['spend'] || 0), 0);
  const dateRange  = rows.length ? `${rows[0]['Reporting starts'] || ''} → ${rows[rows.length-1]['Reporting ends'] || ''}` : '';
  await writeLog(env, 'fb', campaignId, 'ok',
    `${upserted} iklan | ${dateRange} | RM${totalSpend.toFixed(2)} belanja | snap:${snapshotId}`);

  return jsonResp({ ok: true, upserted, source: 'fb', campaign_id: campaignId }, 200, c);
}

// ─── UPLOAD ONPAY CSV ─────────────────────────────────────────────────────────
async function uploadOnpay(request, env, c) {
  const formData   = await request.formData();
  const file       = formData.get('file');
  const campaignId = formData.get('campaign_id') || 'rumah-padi';
  if (!file) return jsonResp({ ok: false, error: 'Tiada fail' }, 400, c);

  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) return jsonResp({ ok: false, error: 'CSV kosong' }, 400, c);

  // Snapshot donations semasa sebelum upload
  const onpaySnapId  = Date.now().toString();
  const existingDon  = await env.DB.prepare(
    'SELECT * FROM donations WHERE campaign_id = ?'
  ).bind(campaignId).all();

  for (const row of existingDon.results) {
    await env.DB.prepare(`
      INSERT INTO donations_snapshots
        (snapshot_id, campaign_id, don_id, uid, donor_name, donor_email,
         amount, source, campaign_name, adset_name, ad_name,
         is_new, status, created_at, raw_extra_2, raw_extra_3)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      onpaySnapId, campaignId, row.id, row.uid, row.donor_name, row.donor_email,
      row.amount, row.source, row.campaign_name, row.adset_name, row.ad_name,
      row.is_new, row.status, row.created_at, row.raw_extra_2, row.raw_extra_3
    ).run();
  }

  // Buang snapshot lama — simpan 5 terkini
  const oldDonSnaps = await env.DB.prepare(`
    SELECT DISTINCT snapshot_id FROM donations_snapshots
    WHERE campaign_id = ? ORDER BY snapped_at DESC LIMIT -1 OFFSET 5
  `).bind(campaignId).all();
  for (const s of oldDonSnaps.results) {
    await env.DB.prepare(
      'DELETE FROM donations_snapshots WHERE snapshot_id = ?'
    ).bind(s.snapshot_id).run();
  }

  let upserted = 0;
  for (const row of rows) {
    const id = row['#'];
    if (!id) continue;

    const donorName = row['Nama'] || '';
    const email     = row['Emel'] || '';
    const extra2    = row['Tambahan #2'] || '';
    const extra3    = row['Tambahan #3'] || '';
    const amount    = parseFloat(row['Jumlah Keseluruhan (RM)'] || 0);
    const createdAt = row['Tarikh & Masa (Dimasukkan)'] || '';

    const isNew  = extra2.toLowerCase().includes('new') ? 1 : 0;
    const source = extra2.split('(')[0].trim();

    const parts    = extra3.split(' | ').map(s => s.trim());
    const campaign = parts[0] || '';
    const adset    = parts[1] || '';
    const adName   = parts[2] || '';

    await env.DB.prepare(`
      INSERT OR REPLACE INTO donations
        (id, donor_name, donor_email, amount, source,
         campaign_id, campaign_name, adset_name, ad_name,
         is_new, status, created_at, raw_extra_2, raw_extra_3)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
    `).bind(
      parseInt(id), donorName, email, amount, source,
      campaignId, campaign, adset, adName,
      isNew, createdAt, extra2, extra3
    ).run();

    upserted++;
  }

  const totalAmount = rows.reduce((s, r) => s + parseFloat(r['Jumlah Keseluruhan (RM)'] || 0), 0);
  await writeLog(env, 'onpay', campaignId, 'ok',
    `${upserted} derma | RM${totalAmount.toFixed(2)} jumlah | snap:${onpaySnapId}`);

  return jsonResp({ ok: true, upserted, source: 'onpay', campaign_id: campaignId }, 200, c);
}

// ─── UPLOAD VIDEO LINKS CSV ───────────────────────────────────────────────────
async function uploadVideos(request, env, c) {
  const formData   = await request.formData();
  const file       = formData.get('file');
  const campaignId = formData.get('campaign_id') || 'rumah-padi';
  if (!file) return jsonResp({ ok: false, error: 'Tiada fail' }, 400, c);

  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) return jsonResp({ ok: false, error: 'CSV kosong' }, 400, c);

  let upserted = 0;
  for (const row of rows) {
    const adName = (row['ad_name'] || row['Ad name'] || '').trim();
    const ytUrl  = (row['youtube_url'] || row['YouTube URL'] || row['url'] || '').trim();
    if (!adName || !ytUrl) continue;

    await env.DB.prepare(`
      INSERT OR REPLACE INTO video_links (campaign_id, ad_name, youtube_url, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).bind(campaignId, adName, ytUrl).run();

    upserted++;
  }

  await writeLog(env, 'videos', campaignId, 'ok', `${upserted} video links dikemas kini`);

  return jsonResp({ ok: true, upserted, source: 'videos', campaign_id: campaignId }, 200, c);
}

// ─── GET METRICS ──────────────────────────────────────────────────────────────
async function getMetrics(request, env, c) {
  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get('campaign_id') || 'rumah-padi';

  const fbResult = await env.DB.prepare(
    'SELECT * FROM fb_ads WHERE campaign_id = ? ORDER BY spend DESC'
  ).bind(campaignId).all();

  const vidResult = await env.DB.prepare(
    'SELECT * FROM video_links WHERE campaign_id = ?'
  ).bind(campaignId).all();
  const vidMap = {};
  for (const v of vidResult.results) vidMap[v.ad_name] = v.youtube_url;

  const donResult = await env.DB.prepare(`
    SELECT
      ad_name,
      COUNT(*)      AS donor_count,
      SUM(amount)   AS total_revenue,
      SUM(is_new)   AS new_donors,
      SUM(1-is_new) AS returning_donors,
      AVG(amount)   AS avg_amount
    FROM donations
    WHERE status = 'confirmed' AND campaign_id = ?
    GROUP BY ad_name
  `).bind(campaignId).all();

  const donMap = {};
  for (const d of donResult.results) donMap[d.ad_name] = d;

  const ads = fbResult.results.map(ad => {
    const don = donMap[ad.ad_name] || {
      donor_count: 0, total_revenue: 0,
      new_donors: 0, returning_donors: 0, avg_amount: 0,
    };
    const roas_actual   = ad.spend > 0 ? don.total_revenue / ad.spend : 0;
    const cvr           = ad.lpv > 0 ? don.donor_count / ad.lpv * 100 : 0;
    const lpv_rate      = ad.link_clicks > 0 ? ad.lpv / ad.link_clicks * 100 : 0;
    const rev_per_lpv   = ad.lpv > 0 ? don.total_revenue / ad.lpv : 0;
    const avg_donation  = don.donor_count > 0 ? don.total_revenue / don.donor_count : 0;
    const hook_to_click = ad.hook_rate > 0 ? ad.ctr / (ad.hook_rate * 100) : 0;
    return {
      ...ad, ...don,
      roas_actual, cvr, lpv_rate, rev_per_lpv, avg_donation, hook_to_click,
      youtube_url: vidMap[ad.ad_name] || null,
    };
  });

  const totalSpend   = ads.reduce((s, a) => s + (a.spend         || 0), 0);
  const totalRevenue = ads.reduce((s, a) => s + (a.total_revenue || 0), 0);
  const totalDonors  = ads.reduce((s, a) => s + (a.donor_count   || 0), 0);
  const totalLPV     = ads.reduce((s, a) => s + (a.lpv           || 0), 0);

  return jsonResp({
    ok: true,
    campaign_id: campaignId,
    summary: {
      total_spend:   totalSpend,
      total_revenue: totalRevenue,
      overall_roas:  totalSpend  > 0 ? totalRevenue / totalSpend   : 0,
      total_ads:     ads.length,
      winners:       ads.filter(a => a.roas_actual >= 1).length,
      total_donors:  totalDonors,
      avg_donation:  totalDonors > 0 ? totalRevenue / totalDonors  : 0,
      overall_cvr:   totalLPV    > 0 ? totalDonors  / totalLPV * 100 : 0,
    },
    ads,
    uploaded_at: new Date().toISOString(),
  }, 200, c);
}

// ─── GET DONATIONS ────────────────────────────────────────────────────────────
async function getDonations(request, env, c) {
  const { searchParams } = new URL(request.url);
  const limit      = Math.min(parseInt(searchParams.get('limit') || '100'), 500);
  const campaignId = searchParams.get('campaign_id') || 'rumah-padi';

  const result = await env.DB.prepare(`
    SELECT * FROM donations
    WHERE status = 'confirmed' AND campaign_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(campaignId, limit).all();

  return jsonResp({ ok: true, donations: result.results }, 200, c);
}

// ─── ONPAY WEBHOOK (real-time) ────────────────────────────────────────────────
async function handleOnpayWebhook(request, env, c) {
  const data = await request.json();
  if (!data.token || data.token !== env.ONPAY_WEBHOOK_TOKEN)
    return new Response('Unauthorized', { status: 401 });
  if (data.event_type !== 'sale.confirmed')
    return jsonResp({ ok: true, skipped: data.event_type }, 200, c);

  const sale       = data.sale;
  const extra2     = sale.extra_field_2 || '';
  const extra3     = sale.extra_field_3 || '';
  const isNew      = extra2.toLowerCase().includes('new') ? 1 : 0;
  const source     = extra2.split('(')[0].trim();
  const parts      = extra3.split(' | ').map(s => s.trim());
  const campaignId = data.campaign_id || 'rumah-padi';

  await env.DB.prepare(`
    INSERT OR REPLACE INTO donations
      (id, uid, donor_name, donor_email, amount, source,
       campaign_id, campaign_name, adset_name, ad_name,
       is_new, payment_method, status, confirmed_at, created_at,
       raw_extra_2, raw_extra_3)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)
  `).bind(
    sale.id, sale.uid, sale.client_fullname, sale.client_email,
    parseFloat(sale.total_amount || 0), source,
    campaignId, parts[0] || '', parts[1] || '', parts[2] || '',
    isNew, sale.payment_method,
    sale.confirmed_at, sale.created_at,
    extra2, extra3
  ).run();

  return jsonResp({ ok: true }, 200, c);
}

// ─── GET SNAPSHOTS ────────────────────────────────────────────────────────────
async function getSnapshots(request, env, c) {
  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get('campaign_id') || 'rumah-padi';

  const fbSnaps = await env.DB.prepare(`
    SELECT snapshot_id, MIN(created_at) AS created_at, COUNT(*) AS row_count
    FROM fb_ads_snapshots WHERE campaign_id = ?
    GROUP BY snapshot_id ORDER BY created_at DESC LIMIT 5
  `).bind(campaignId).all();

  const donSnaps = await env.DB.prepare(`
    SELECT snapshot_id, MIN(snapped_at) AS created_at, COUNT(*) AS row_count
    FROM donations_snapshots WHERE campaign_id = ?
    GROUP BY snapshot_id ORDER BY snapped_at DESC LIMIT 5
  `).bind(campaignId).all();

  return jsonResp({
    ok: true,
    fb:    fbSnaps.results,
    onpay: donSnaps.results,
  }, 200, c);
}

// ─── ROLLBACK ─────────────────────────────────────────────────────────────────
async function rollbackFB(request, env, c) {
  const { snapshot_id, campaign_id, type } = await request.json();
  if (!snapshot_id || !campaign_id)
    return jsonResp({ ok: false, error: 'snapshot_id dan campaign_id diperlukan' }, 400, c);

  const snapTime = new Date(parseInt(snapshot_id)).toLocaleString('ms-MY');

  if (type === 'onpay') {
    // Rollback Onpay donations
    const snap = await env.DB.prepare(
      'SELECT * FROM donations_snapshots WHERE snapshot_id = ? AND campaign_id = ?'
    ).bind(snapshot_id, campaign_id).all();

    if (!snap.results.length)
      return jsonResp({ ok: false, error: 'Snapshot tidak dijumpai' }, 404, c);

    await env.DB.prepare('DELETE FROM donations WHERE campaign_id = ?').bind(campaign_id).run();

    for (const row of snap.results) {
      await env.DB.prepare(`
        INSERT INTO donations
          (id, uid, donor_name, donor_email, amount, source,
           campaign_id, campaign_name, adset_name, ad_name,
           is_new, status, created_at, raw_extra_2, raw_extra_3)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        row.don_id, row.uid, row.donor_name, row.donor_email,
        row.amount, row.source, campaign_id,
        row.campaign_name, row.adset_name, row.ad_name,
        row.is_new, row.status, row.created_at,
        row.raw_extra_2, row.raw_extra_3
      ).run();
    }

    await writeLog(env, 'rollback', campaign_id, 'ok',
      `↩ Onpay rollback ke ${snapTime} | ${snap.results.length} derma dipulihkan`);

    return jsonResp({ ok: true, restored: snap.results.length }, 200, c);
  }

  // Rollback FB Ads (default)
  const snap = await env.DB.prepare(
    'SELECT * FROM fb_ads_snapshots WHERE snapshot_id = ? AND campaign_id = ?'
  ).bind(snapshot_id, campaign_id).all();

  if (!snap.results.length)
    return jsonResp({ ok: false, error: 'Snapshot tidak dijumpai' }, 404, c);

  await env.DB.prepare('DELETE FROM fb_ads WHERE campaign_id = ?').bind(campaign_id).run();

  for (const row of snap.results) {
    await env.DB.prepare(`
      INSERT INTO fb_ads
        (campaign_id, ad_name, spend, impressions, reach, ctr,
         purchases, cost_per_result, purchase_roas, lpv, cost_per_lpv,
         hook_rate, cpc, link_clicks, frequency, cpm, date_start, date_stop, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      row.campaign_id, row.ad_name,
      row.spend, row.impressions, row.reach, row.ctr,
      row.purchases, row.cost_per_result, row.purchase_roas,
      row.lpv, row.cost_per_lpv, row.hook_rate,
      row.cpc, row.link_clicks, row.frequency, row.cpm,
      row.date_start, row.date_stop
    ).run();
  }

  await writeLog(env, 'rollback', campaign_id, 'ok',
    `↩ FB Ads rollback ke ${snapTime} | ${snap.results.length} iklan dipulihkan`);

  return jsonResp({ ok: true, restored: snap.results.length }, 200, c);
}

// ─── WRITE LOG ────────────────────────────────────────────────────────────────
async function writeLog(env, type, campaignId, status, message) {
  await env.DB.prepare(`
    INSERT INTO sync_log (type, status, message, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).bind(`${type}:${campaignId}`, status, message).run();
}

// ─── GET LOGS ─────────────────────────────────────────────────────────────────
async function getLogs(request, env, c) {
  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get('campaign_id') || 'rumah-padi';
  const limit      = Math.min(parseInt(searchParams.get('limit') || '20'), 100);

  const result = await env.DB.prepare(`
    SELECT * FROM sync_log
    WHERE type LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(`%:${campaignId}`, limit).all();

  return jsonResp({ ok: true, logs: result.results }, 200, c);
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/);
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1)
    .map(line => {
      if (!line.trim()) return null;
      const vals = parseCSVLine(line);
      const obj  = {};
      headers.forEach((h, i) => {
        obj[h.trim().replace(/^"|"$/g, '')] = (vals[i] || '').trim().replace(/^"|"$/g, '');
      });
      return obj;
    })
    .filter(Boolean);
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === ',' && !inQ) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}
