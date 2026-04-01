function parseTenantId(value) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function resolveTenantId(req) {
    const fromSession = parseTenantId(req?.session?.admin?.tenant_id);
    if (fromSession) return fromSession;

    const fromHeader = parseTenantId(req?.headers?.['x-tenant-id']);
    if (fromHeader) return fromHeader;

    const fromQuery = parseTenantId(req?.query?.tenant_id);
    if (fromQuery) return fromQuery;

    const fromBody = parseTenantId(req?.body?.tenant_id);
    if (fromBody) return fromBody;

    const fromEnv = parseTenantId(process.env.DEFAULT_TENANT_ID);
    if (fromEnv) return fromEnv;

    return null;
}

function attachTenantContext(req, _res, next) {
    req.tenantId = resolveTenantId(req);
    next();
}

function requireTenantContext(req, res, next) {
    req.tenantId = resolveTenantId(req);
    if (!req.tenantId) {
        return res.status(400).json({
            success: false,
            code: 'TENANT_REQUIRED',
            message: '缺少 tenant_id，請先綁定租戶再發送請求'
        });
    }
    return next();
}

module.exports = {
    attachTenantContext,
    requireTenantContext,
    resolveTenantId
};
