function registerScheduledJobs(deps) {
    const {
        cron,
        bookingJobs,
        adminLogCleanupJobs,
        subscriptionJobs,
        timezone = 'Asia/Taipei'
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

    // 多租戶：不自動每日全庫備份（租戶一多會重複佔用空間）。
    // 各租戶請於後台「資料備份管理」手動備份；還原前可選安全備份。
    console.log('ℹ️ 資料庫備份：未啟用排程備份（多租戶改由租戶手動備份）');

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
    if (subscriptionJobs && typeof subscriptionJobs.runNewebpayReconcileJob === 'function') {
        cron.schedule('*/10 * * * *', subscriptionJobs.runNewebpayReconcileJob, { timezone });
        console.log('✅ 藍新訂閱補償任務已啟動（每 10 分鐘重試同步）');
    }
}

module.exports = {
    registerScheduledJobs
};
