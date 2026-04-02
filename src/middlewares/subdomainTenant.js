/**
 * 依子網域辨識租戶：Host 為 {tenantLabel}.{PUBLIC_BASE_DOMAIN} 時查 tenants.code
 * 需設定環境變數 PUBLIC_BASE_DOMAIN（例如 yourdomain.com 或 app.up.railway.app），未設定則略過。
 */

function getHostname(req) {
    const raw = String(req.get('x-forwarded-host') || req.get('host') || '').trim();
    return raw.split(':')[0].toLowerCase();
}

function extractTenantLabel(hostname, baseDomain) {
    const base = String(baseDomain || '').trim().toLowerCase();
    const host = String(hostname || '').trim().toLowerCase();
    if (!base || !host) return null;
    if (host === base || host === `www.${base}`) return null;
    if (!host.endsWith('.' + base)) return null;
    const rest = host.slice(0, -(base.length + 1));
    if (!rest) return null;
    const labels = rest.split('.').filter(Boolean);
    if (!labels.length) return null;
    const first = labels[0];
    if (first === 'www' && labels.length > 1) return labels[1];
    if (first === 'www') return null;
    return first;
}

function sendSubdomainTenantError(req, res, status, payload) {
    const wantsJson =
        (req.get('accept') || '').includes('application/json') ||
        (req.path && req.path.startsWith('/api/'));
    if (wantsJson) {
        return res.status(status).json({ success: false, ...payload });
    }
    const msg = payload.message || '';
    return res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>${status}</title></head>
<body style="font-family:sans-serif;padding:2rem;">
<h1>${status === 404 ? '找不到租戶' : '無法存取'}</h1>
<p>${msg}</p>
</body></html>`);
}

function createSubdomainTenantMiddleware({ db, publicBaseDomain }) {
    const base = String(publicBaseDomain || '').trim();

    return async function subdomainTenant(req, res, next) {
        if (!base) {
            return next();
        }

        const host = getHostname(req);
        const label = extractTenantLabel(host, base);

        if (!label) {
            return next();
        }

        try {
            const row = await db.getTenantBySubdomainLabel(label);
            if (!row) {
                return sendSubdomainTenantError(req, res, 404, {
                    code: 'TENANT_NOT_FOUND',
                    message: '找不到此子網域對應的租戶，請確認租戶代碼與 DNS 設定'
                });
            }
            const st = String(row.status || '').toLowerCase();
            if (st !== 'active') {
                return sendSubdomainTenantError(req, res, 403, {
                    code: 'TENANT_INACTIVE',
                    message: '此租戶尚未啟用或已停用，無法使用前台'
                });
            }
            req.subdomainTenantId = row.id;
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

module.exports = {
    createSubdomainTenantMiddleware,
    extractTenantLabel,
    getHostname
};
