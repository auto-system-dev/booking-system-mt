function registerScheduledJobs(deps) {
    const {
        cron,
        bookingJobs,
        adminLogCleanupJobs,
        subscriptionJobs,
        backup,
        db,
        timezone = 'Asia/Taipei',
        processEnv = process.env
    } = deps;

    cron.schedule('0 * * * *', bookingJobs.sendPaymentReminderEmails, {
        timezone
    });
    console.log('✅ 匯款提醒定時任務已啟動（每小時檢查，根據模板設定時間發送）');

    cron.schedule('0 * * * *', bookingJobs.sendCheckinReminderEmails, {
        timezone
    });
    console.log('✅ 入住提醒定時任務已啟動（每小時檢查，根據模板設定時間發送）');

    cron.schedule('0 * * * *', bookingJobs.sendFeedbackRequestEmails, {
        timezone
    });
    console.log('✅ 回訪信定時任務已啟動（每小時檢查，根據模板設定時間發送）');

    cron.schedule('30 * * * *', bookingJobs.cancelExpiredReservations, {
        timezone
    });
    console.log('✅ 自動取消過期保留訂房定時任務已啟動（每小時 30 分檢查）');

    const dailyBackupEnabled = String(processEnv.ENABLE_DAILY_BACKUP || 'true').trim().toLowerCase() !== 'false';
    const dailyBackupCron = String(processEnv.DAILY_BACKUP_CRON || '0 2 * * *').trim();
    const backupRetentionDays = Math.max(1, parseInt(processEnv.BACKUP_RETENTION_DAYS || '30', 10) || 30);

    if (dailyBackupEnabled && backup && db && typeof backup.performBackup === 'function' && typeof backup.cleanupOldBackups === 'function') {
        cron.schedule(dailyBackupCron, async () => {
            console.log('🧰 [排程備份] 開始每日全備任務...');
            try {
                const tenantOverview = typeof db.getAllTenantSubscriptionOverview === 'function'
                    ? await db.getAllTenantSubscriptionOverview()
                    : [];
                const candidates = Array.isArray(tenantOverview) ? tenantOverview : [];

                const backupTargets = [];
                let skippedDoubleCanceled = 0;
                for (const row of candidates) {
                    const tenantId = parseInt(row?.tenantId, 10);
                    if (!Number.isInteger(tenantId) || tenantId <= 0) continue;

                    const tenantStatus = String(row?.tenantStatus || '').trim().toLowerCase();
                    const subscriptionStatus = String(row?.subscriptionStatus || '').trim().toLowerCase();
                    const isDoubleCanceled = tenantStatus === 'canceled' && subscriptionStatus === 'canceled';
                    if (isDoubleCanceled) {
                        skippedDoubleCanceled += 1;
                        continue;
                    }
                    backupTargets.push(tenantId);
                }

                const uniqueTenantIds = Array.from(new Set(backupTargets));
                if (uniqueTenantIds.length === 0) {
                    console.log('ℹ️ [排程備份] 找不到可備份租戶，略過。');
                    return;
                }

                for (const tenantId of uniqueTenantIds) {
                    try {
                        const backupResult = await backup.performBackup(tenantId);
                        await backup.cleanupOldBackups(backupRetentionDays, tenantId);
                        console.log(`✅ [排程備份] tenant ${tenantId} 完成：${backupResult?.fileName || 'unknown file'}`);
                    } catch (tenantError) {
                        console.error(`❌ [排程備份] tenant ${tenantId} 失敗：`, tenantError.message || tenantError);
                    }
                }
                console.log(`✅ [排程備份] 全部完成（備份租戶數：${uniqueTenantIds.length}，略過雙取消：${skippedDoubleCanceled}，保留天數：${backupRetentionDays}）`);
            } catch (error) {
                console.error('❌ [排程備份] 任務失敗：', error.message || error);
            }
        }, { timezone });
        console.log(`✅ 資料庫每日全備已啟動（${dailyBackupCron}，保留 ${backupRetentionDays} 天）`);
    } else {
        console.log('ℹ️ 資料庫每日全備未啟用（缺少 backup/db 依賴或 ENABLE_DAILY_BACKUP=false）');
    }

    if (adminLogCleanupJobs.isEnabled()) {
        cron.schedule('15 3 * * *', async () => {
            await adminLogCleanupJobs.runDailyCron();
        }, {
            timezone
        });
        console.log('✅ 操作日誌自動清理任務已啟動（每天 03:15 台灣時間）');
    }

    if (subscriptionJobs && typeof subscriptionJobs.runDailySubscriptionCheck === 'function') {
        cron.schedule('5 0 * * *', subscriptionJobs.runDailySubscriptionCheck, { timezone });
        console.log('✅ 訂閱狀態日檢任務已啟動（每天 00:05 台灣時間）');
    }
    const reconcileEnabled = String(processEnv.ENABLE_NEWEBPAY_RECONCILE || 'false').trim().toLowerCase() === 'true';
    if (reconcileEnabled && subscriptionJobs && typeof subscriptionJobs.runNewebpayReconcileJob === 'function') {
        cron.schedule('*/10 * * * *', subscriptionJobs.runNewebpayReconcileJob, { timezone });
        console.log('✅ 藍新訂閱補償任務已啟動（每 10 分鐘重試同步）');
    } else {
        console.log('⏸️ 藍新訂閱補償任務已停用（僅驗證 webhook 主路徑）');
    }
}

module.exports = {
    registerScheduledJobs
};
