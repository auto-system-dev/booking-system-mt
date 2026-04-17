function createCheckPermission(db) {
    const permissionAliases = {
        'landing.view': ['settings.view'],
        'landing.edit': ['settings.edit'],
        'landing.rooms.edit': ['room_types.edit']
    };

    return function checkPermission(permissionCode) {
        return async (req, res, next) => {
            try {
                if (!req.session || !req.session.admin) {
                    return res.status(401).json({ success: false, message: '未登入' });
                }

                const adminId = req.session.admin.id;
                const permissions = req.session.admin.permissions || [];
                const requestedCodes = Array.isArray(permissionCode)
                    ? permissionCode.filter(Boolean).map((code) => String(code).trim())
                    : [String(permissionCode || '').trim()].filter(Boolean);
                const expandedCodes = new Set();
                requestedCodes.forEach((code) => {
                    expandedCodes.add(code);
                    const aliases = permissionAliases[code] || [];
                    aliases.forEach((alias) => expandedCodes.add(alias));
                });
                const checkCodes = Array.from(expandedCodes).filter(Boolean);

                if (checkCodes.length === 0) {
                    return res.status(400).json({ success: false, message: '權限代碼未設定' });
                }

                if (checkCodes.some((code) => permissions.includes(code))) {
                    return next();
                }

                for (const code of checkCodes) {
                    const granted = await db.hasPermission(adminId, code);
                    if (granted) {
                        if (!req.session.admin.permissions) {
                            req.session.admin.permissions = await db.getAdminPermissions(adminId);
                        }
                        return next();
                    }
                }

                await db.logAdminAction({
                    adminId: adminId,
                    adminUsername: req.session.admin.username,
                    action: 'permission_denied',
                    resourceType: 'permission',
                    resourceId: requestedCodes.join(','),
                    details: JSON.stringify({ requestedPermission: requestedCodes, checkedPermissionCodes: checkCodes }),
                    ipAddress: req.ip || req.connection?.remoteAddress || 'unknown',
                    userAgent: req.get('user-agent') || 'unknown'
                }).catch(err => console.error('記錄權限檢查失敗日誌錯誤:', err));

                return res.status(403).json({
                    success: false,
                    message: '您沒有權限執行此操作'
                });
            } catch (error) {
                console.error('❌ checkPermission 中間件錯誤:', error.message);
                return res.status(500).json({
                    success: false,
                    message: '權限檢查失敗: ' + error.message
                });
            }
        };
    };
}

module.exports = {
    createCheckPermission
};
