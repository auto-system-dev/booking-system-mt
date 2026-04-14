function createSubscriptionGate(db) {
    async function readSnapshot(req) {
        const tenantId = req.tenantId || req?.session?.admin?.tenant_id;
        if (!tenantId) {
            throw new Error('tenant_id is required');
        }
        const snapshot = await db.getTenantSubscriptionSnapshot(tenantId);
        req.subscription = snapshot;
        return snapshot;
    }

    function requireSubscriptionActive(req, res, next) {
        readSnapshot(req)
            .then((snapshot) => {
                if (snapshot.status === 'canceled') {
                    return res.status(402).json({
                        success: false,
                        code: 'SUBSCRIPTION_CANCELED',
                        message: '目前訂閱已停用，請續訂後使用此功能'
                    });
                }
                return next();
            })
            .catch((error) => {
                return res.status(500).json({
                    success: false,
                    code: 'SUBSCRIPTION_GATE_ERROR',
                    message: '訂閱狀態檢查失敗: ' + error.message
                });
            });
    }

    function requireFeature(featureKey) {
        return (req, res, next) => {
            // 超級管理員略過方案功能限制（仍需通過其他權限/租戶檢查）
            if (req?.session?.admin?.role === 'super_admin') {
                return next();
            }
            readSnapshot(req)
                .then((snapshot) => {
                    if (snapshot.status === 'canceled') {
                        return res.status(402).json({
                            success: false,
                            code: 'SUBSCRIPTION_CANCELED',
                            message: '目前訂閱已停用，請續訂後使用此功能'
                        });
                    }

                    const hasFeature = !!snapshot.features?.[featureKey];
                    if (!hasFeature) {
                        return res.status(403).json({
                            success: false,
                            code: 'FEATURE_NOT_AVAILABLE',
                            message: `目前方案不支援功能: ${featureKey}`
                        });
                    }
                    return next();
                })
                .catch((error) => {
                    return res.status(500).json({
                        success: false,
                        code: 'SUBSCRIPTION_GATE_ERROR',
                        message: '功能權限檢查失敗: ' + error.message
                    });
                });
        };
    }

    function enforceBuildingLimit(req, res, next) {
        readSnapshot(req)
            .then(async (snapshot) => {
                if (snapshot.status === 'canceled') {
                    return res.status(402).json({
                        success: false,
                        code: 'SUBSCRIPTION_CANCELED',
                        message: '目前訂閱已停用，請續訂後再新增分店'
                    });
                }
                const limit = Number(snapshot.limits?.max_buildings || 0);
                if (limit <= 0) return next();

                const count = await db.getBuildingCountByTenant(req.tenantId);
                if (count >= limit) {
                    return res.status(403).json({
                        success: false,
                        code: 'BUILDING_LIMIT_REACHED',
                        message: `方案分店數上限為 ${limit}，目前已達上限`
                    });
                }
                return next();
            })
            .catch((error) => {
                return res.status(500).json({
                    success: false,
                    code: 'SUBSCRIPTION_GATE_ERROR',
                    message: '分店數限制檢查失敗: ' + error.message
                });
            });
    }

    function enforceAdminLimit(req, res, next) {
        if (req?.session?.admin?.role === 'super_admin') {
            return next();
        }
        readSnapshot(req)
            .then(async (snapshot) => {
                if (snapshot.status === 'canceled') {
                    return res.status(402).json({
                        success: false,
                        code: 'SUBSCRIPTION_CANCELED',
                        message: '目前訂閱已停用，請續訂後再新增管理員'
                    });
                }
                const limit = Number(snapshot.limits?.max_admins || 0);
                if (limit <= 0) return next();

                const count = await db.getAdminCountByTenant(req.tenantId);
                if (count >= limit) {
                    return res.status(403).json({
                        success: false,
                        code: 'ADMIN_LIMIT_REACHED',
                        message: `方案管理員上限為 ${limit} 席，目前已達上限`
                    });
                }
                return next();
            })
            .catch((error) => {
                return res.status(500).json({
                    success: false,
                    code: 'SUBSCRIPTION_GATE_ERROR',
                    message: '管理員席次限制檢查失敗: ' + error.message
                });
            });
    }

    return {
        requireSubscriptionActive,
        requireFeature,
        enforceBuildingLimit,
        enforceAdminLimit
    };
}

module.exports = {
    createSubscriptionGate
};

