function createSubscriptionGate(db) {
    function resolveAdminSeatLimit(snapshot) {
        const explicitLimit = Number(snapshot?.limits?.max_admins || 0);
        if (Number.isFinite(explicitLimit) && explicitLimit > 0) {
            return explicitLimit;
        }
        // 舊資料可能尚未寫入 max_admins，使用方案資訊推估合理預設值
        const planCode = String(snapshot?.planCode || '').trim().toLowerCase();
        if (planCode.startsWith('basic_')) return 2;
        const maxBuildings = Number(snapshot?.limits?.max_buildings || 0);
        return Number.isFinite(maxBuildings) && maxBuildings > 1 ? 5 : 2;
    }

    function resolveRoomTypeLimit(snapshot) {
        const explicitLimit = Number(snapshot?.limits?.max_room_types || 0);
        if (Number.isFinite(explicitLimit) && explicitLimit > 0) {
            return explicitLimit;
        }
        const planCode = String(snapshot?.planCode || '').trim().toLowerCase();
        if (planCode.startsWith('basic_')) return 10;
        const maxBuildings = Number(snapshot?.limits?.max_buildings || 0);
        return Number.isFinite(maxBuildings) && maxBuildings > 1 ? 50 : 10;
    }

    function resolveTenantId(req) {
        const raw = req?.tenantId ?? req?.session?.admin?.tenant_id ?? null;
        const tenantId = parseInt(raw, 10);
        if (!Number.isInteger(tenantId) || tenantId <= 0) {
            throw new Error('tenant_id is required');
        }
        return tenantId;
    }

    async function readSnapshot(req) {
        const tenantId = resolveTenantId(req);
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

                const tenantId = resolveTenantId(req);
                const count = await db.getBuildingCountByTenant(tenantId);
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
                const limit = resolveAdminSeatLimit(snapshot);
                if (limit <= 0) return next();

                const tenantId = resolveTenantId(req);
                const count = await db.getAdminCountByTenant(tenantId);
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

    function enforceRoomTypeLimit(req, res, next) {
        readSnapshot(req)
            .then(async (snapshot) => {
                if (snapshot.status === 'canceled') {
                    return res.status(402).json({
                        success: false,
                        code: 'SUBSCRIPTION_CANCELED',
                        message: '目前訂閱已停用，請續訂後再新增房型'
                    });
                }
                const limit = resolveRoomTypeLimit(snapshot);
                if (limit <= 0) return next();

                const tenantId = resolveTenantId(req);
                const count = await db.getRoomTypeCountByTenant(tenantId);
                if (count >= limit) {
                    return res.status(403).json({
                        success: false,
                        code: 'ROOM_TYPE_LIMIT_REACHED',
                        message: `方案房間數量上限為 ${limit} 間，目前已達上限`
                    });
                }
                return next();
            })
            .catch((error) => {
                return res.status(500).json({
                    success: false,
                    code: 'SUBSCRIPTION_GATE_ERROR',
                    message: '房型上限檢查失敗: ' + error.message
                });
            });
    }

    return {
        requireSubscriptionActive,
        requireFeature,
        enforceBuildingLimit,
        enforceAdminLimit,
        enforceRoomTypeLimit
    };
}

module.exports = {
    createSubscriptionGate
};

