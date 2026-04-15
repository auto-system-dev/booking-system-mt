function parseTenantId(value) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function resolveTenantId(req) {
    const fromSession = parseTenantId(req?.session?.admin?.tenant_id);
    if (fromSession) return fromSession;

    const admin = req?.session?.admin;
    // 已登入的一般管理員：若 session 未綁定有效租戶，不可再套用 header／query／body／預設租戶
    if (admin && admin.role !== 'super_admin') {
        return null;
    }

    // 匿名請求僅允許子網域或預設租戶，不信任客戶端自行帶入 tenant_id。
    const fromSubdomain = parseTenantId(req?.subdomainTenantId);
    if (fromSubdomain) return fromSubdomain;

    // 只有 super admin 允許透過 header/query/body 明確指定目標租戶。
    if (admin?.role === 'super_admin') {
        const fromHeader = parseTenantId(req?.headers?.['x-tenant-id']);
        if (fromHeader) return fromHeader;

        const fromQuery = parseTenantId(req?.query?.tenant_id);
        if (fromQuery) return fromQuery;

        const fromBody = parseTenantId(req?.body?.tenant_id);
        if (fromBody) return fromBody;
    }

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
