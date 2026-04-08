function parseTenantId(value) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function resolveTenantId(req) {
    const fromSession = parseTenantId(req?.session?.admin?.tenant_id);
    if (fromSession) return fromSession;

    // 已登入的一般管理員：若 session 未綁定有效租戶，不可再套用 header／環境預設租戶，
    // 否則儀表板等 API 會誤讀 DEFAULT_TENANT_ID（常為 1）的訂房資料。
    const admin = req?.session?.admin;
    if (admin && admin.role !== 'super_admin') {
        return null;
    }

    const fromHeader = parseTenantId(req?.headers?.['x-tenant-id']);
    if (fromHeader) return fromHeader;

    const fromSubdomain = parseTenantId(req?.subdomainTenantId);
    if (fromSubdomain) return fromSubdomain;

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
