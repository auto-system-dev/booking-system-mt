function createBookingNotificationJobs(deps) {
    const {
        db,
        notificationService,
        getHotelSettingsWithFallback,
        calculateDynamicPaymentDeadline
    } = deps;
    const defaultTenantId = parseInt(process.env.DEFAULT_TENANT_ID || '1', 10);
    
    async function getActiveTenantIds() {
        try {
            const overview = await db.getTenantsOverview({ status: 'active', limit: 2000, offset: 0 });
            // getTenantsOverview 回傳 { items, total, ... }，不是陣列
            const list = Array.isArray(overview)
                ? overview
                : (Array.isArray(overview?.items) ? overview.items : []);
            const ids = list
                .map((t) => parseInt(t.id, 10))
                .filter((id) => Number.isInteger(id) && id > 0);
            return ids.length > 0 ? ids : [defaultTenantId];
        } catch (error) {
            console.warn('⚠️  取得租戶清單失敗，回退預設租戶執行排程:', error.message);
            return [defaultTenantId];
        }
    }

    async function sendPaymentReminderEmails() {
        try {
            const now = new Date();
            console.log(`\n[定時任務] 開始檢查匯款期限提醒... (${now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })})`);

            const tenantIds = await getActiveTenantIds();
            const currentHour = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false });
            const currentHourNum = parseInt(currentHour);

            for (const tenantId of tenantIds) {
                const template = await db.getEmailTemplateByKey('payment_reminder', tenantId);
                if (!template) {
                    console.log(`⚠️ 租戶 ${tenantId} 找不到匯款提醒模板，跳過`);
                    continue;
                }
                if (!template.is_enabled) {
                    console.log(`⚠️ 租戶 ${tenantId} 匯款提醒模板未啟用，跳過`);
                    continue;
                }

                const daysReserved = parseInt(template.days_reserved) || 3;
                const sendHour = parseInt(template.send_hour_payment_reminder) || 9;
                if (currentHourNum !== sendHour) {
                    console.log(`⏰ 租戶 ${tenantId} 當前時間 ${currentHourNum}:00 不符合發送時間 ${sendHour}:00，跳過`);
                    continue;
                }

                const allBookings = await db.getBookingsForPaymentReminder(tenantId);
                console.log(`租戶 ${tenantId} 初步查詢找到 ${allBookings.length} 筆可能的訂房`);

                const bookings = allBookings.filter((booking) => {
                if (!booking.check_in_date) {
                    return false;
                }

                const { deadline } = calculateDynamicPaymentDeadline(booking.created_at, booking.check_in_date, daysReserved);

                const created = new Date(booking.created_at);
                created.setHours(0, 0, 0, 0);
                const checkIn = new Date(booking.check_in_date);
                checkIn.setHours(0, 0, 0, 0);
                const diffTime = checkIn.getTime() - created.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays === 1) {
                    return false;
                }

                if (diffDays <= daysReserved && diffDays > 1) {
                    const reminderDate = new Date(checkIn);
                    reminderDate.setDate(reminderDate.getDate() - 1);
                    reminderDate.setHours(0, 0, 0, 0);

                    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    return reminderDate.getTime() === today.getTime() && currentHourNum === sendHour;
                }

                const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const deadlineDay = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
                return deadlineDay.getTime() === today.getTime() && currentHourNum === sendHour;
                });

                console.log(`租戶 ${tenantId} 找到 ${bookings.length} 筆需要發送匯款提醒的訂房`);

                const bankInfo = {
                    bankName: await db.getSetting('bank_name', tenantId) || '',
                    bankBranch: await db.getSetting('bank_branch', tenantId) || '',
                    account: await db.getSetting('bank_account', tenantId) || '',
                    accountName: await db.getSetting('account_name', tenantId) || ''
                };

                for (const booking of bookings) {
                    try {
                        const emailSent = await notificationService.sendPaymentReminderEmail({
                            booking,
                            bankInfo,
                            template
                        });
                        if (emailSent) {
                            console.log(`✅ 已發送匯款提醒給 ${booking.guest_name} (${booking.booking_id})`);
                        }
                    } catch (error) {
                        console.error(`❌ 發送匯款提醒失敗 (${booking.booking_id}):`, error.message);
                    }
                }
            }
        } catch (error) {
            console.error('❌ 匯款提醒任務錯誤:', error);
        }
    }

    async function cancelExpiredReservations() {
        try {
            console.log('\n[定時任務] 開始檢查過期保留訂房...');
            const bookings = await db.getBookingsExpiredReservation();
            console.log(`找到 ${bookings.length} 筆保留狀態的訂房`);

            const daysReservedByTenant = new Map();
            const getDaysReservedForTenant = async (tenantId) => {
                if (daysReservedByTenant.has(tenantId)) return daysReservedByTenant.get(tenantId);
                let value = 3;
                try {
                    const paymentTemplate = await db.getEmailTemplateByKey('payment_reminder', tenantId);
                    if (paymentTemplate && paymentTemplate.days_reserved) {
                        value = parseInt(paymentTemplate.days_reserved) || 3;
                    }
                } catch (err) {
                    console.warn(`取得租戶 ${tenantId} 匯款提醒模板失敗，使用預設 days_reserved=3:`, err.message);
                }
                daysReservedByTenant.set(tenantId, value);
                return value;
            };

            const now = new Date();
            let cancelledCount = 0;
            let emailSentCount = 0;
            let emailFailedCount = 0;

            for (const booking of bookings) {
                try {
                    if (!booking.check_in_date) {
                        continue;
                    }

                    const tenantId = parseInt(booking.tenant_id, 10) || defaultTenantId;
                    const daysReserved = await getDaysReservedForTenant(tenantId);
                    const { deadline } = calculateDynamicPaymentDeadline(booking.created_at, booking.check_in_date, daysReserved);

                    if (now > deadline) {
                        await db.cancelBooking(booking.booking_id, booking.tenant_id);
                        console.log(`✅ 已自動取消過期保留訂房: ${booking.booking_id} (${booking.guest_name})`);
                        cancelledCount++;

                        try {
                            const emailSent = await notificationService.sendCancelNotificationEmail(booking);
                            if (emailSent) {
                                console.log(`✅ 已發送取消通知給 ${booking.guest_name} (${booking.booking_id})`);
                                emailSentCount++;
                            } else {
                                emailFailedCount++;
                            }
                        } catch (emailError) {
                            console.error(`❌ 發送取消通知時發生錯誤 (${booking.booking_id}):`, emailError.message);
                            emailFailedCount++;
                        }
                    }
                } catch (error) {
                    console.error(`❌ 取消過期保留訂房失敗 (${booking.booking_id}):`, error.message);
                }
            }

            console.log(`✅ 共取消 ${cancelledCount} 筆過期保留訂房`);
            console.log(`📧 成功發送 ${emailSentCount} 封取消通知郵件`);
            if (emailFailedCount > 0) {
                console.warn(`⚠️  有 ${emailFailedCount} 封取消通知郵件發送失敗`);
            }
        } catch (error) {
            console.error('❌ 自動取消過期保留訂房任務錯誤:', error);
        }
    }

    async function sendCheckinReminderEmails() {
        try {
            const now = new Date();
            console.log(`\n[定時任務] 開始檢查入住提醒... (${now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })})`);

            const currentHour = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false });
            const currentHourNum = parseInt(currentHour);
            const tenantIds = await getActiveTenantIds();

            for (const tenantId of tenantIds) {
                const template = await db.getEmailTemplateByKey('checkin_reminder', tenantId);
                if (!template) {
                    console.log(`⚠️ 租戶 ${tenantId} 找不到入住提醒模板，跳過`);
                    continue;
                }
                if (!template.is_enabled) {
                    console.log(`⚠️ 租戶 ${tenantId} 入住提醒模板未啟用，跳過`);
                    continue;
                }

                const daysBeforeCheckin = parseInt(template.days_before_checkin) || 1;
                const sendHour = parseInt(template.send_hour_checkin) || 9;
                if (currentHourNum !== sendHour) {
                    console.log(`⏰ 租戶 ${tenantId} 當前時間 ${currentHourNum}:00 不符合發送時間 ${sendHour}:00，跳過`);
                    continue;
                }

                const bookings = await db.getBookingsForCheckinReminder(daysBeforeCheckin, tenantId);
                console.log(`租戶 ${tenantId} 找到 ${bookings.length} 筆需要發送入住提醒的訂房`);
                const hotelSettings = await getHotelSettingsWithFallback(tenantId);

                for (const booking of bookings) {
                    try {
                    const templateContent = template.content || '';
                    const templateSubject = template.subject || '';

                    if (!templateContent || templateContent.trim() === '') {
                        console.error(`❌ 入住提醒模板內容為空，跳過發送 (${booking.booking_id})`);
                        continue;
                    }
                    if (!templateSubject || templateSubject.trim() === '') {
                        console.error(`❌ 入住提醒模板主題為空，跳過發送 (${booking.booking_id})`);
                        continue;
                    }

                    console.log(`📧 準備發送入住提醒郵件 (${booking.booking_id})，模板內容長度: ${templateContent.length} 字元`);
                    console.log('📋 使用資料庫中保存的完整模板內容');

                    const additionalData = {
                        '{{hotelEmail}}': hotelSettings.hotelEmail,
                        '{{hotelPhone}}': hotelSettings.hotelPhone
                    };

                        const emailSent = await notificationService.sendCheckinReminderEmail({
                            booking,
                            template,
                            additionalData
                        });
                        if (emailSent) {
                            console.log(`✅ 已發送入住提醒給 ${booking.guest_name} (${booking.booking_id})`);
                        }
                    } catch (error) {
                        console.error(`❌ 發送入住提醒失敗 (${booking.booking_id}):`, error.message);
                    }
                }
            }
        } catch (error) {
            console.error('❌ 入住提醒任務錯誤:', error);
        }
    }

    async function sendFeedbackRequestEmails() {
        try {
            const now = new Date();
            console.log(`\n[定時任務] 開始檢查回訪信... (${now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })})`);

            const currentHour = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false });
            const currentHourNum = parseInt(currentHour);
            const tenantIds = await getActiveTenantIds();

            for (const tenantId of tenantIds) {
                const template = await db.getEmailTemplateByKey('feedback_request', tenantId);
                if (!template) {
                    console.log(`⚠️ 租戶 ${tenantId} 找不到回訪信模板，跳過`);
                    continue;
                }
                if (!template.is_enabled) {
                    console.log(`⚠️ 租戶 ${tenantId} 回訪信模板未啟用，跳過`);
                    continue;
                }

                const daysAfterCheckout = parseInt(template.days_after_checkout) || 1;
                const sendHour = parseInt(template.send_hour_feedback) || 10;
                if (currentHourNum !== sendHour) {
                    console.log(`⏰ 租戶 ${tenantId} 當前時間 ${currentHourNum}:00 不符合發送時間 ${sendHour}:00，跳過`);
                    continue;
                }

                const bookings = await db.getBookingsForFeedbackRequest(daysAfterCheckout, tenantId);
                console.log(`租戶 ${tenantId} 找到 ${bookings.length} 筆需要發送回訪信的訂房`);

                const hotelSettings = await getHotelSettingsWithFallback(tenantId);

                for (const booking of bookings) {
                    try {
                    const additionalData = {
                        '{{hotelEmail}}': hotelSettings.hotelEmail,
                        '{{hotelPhone}}': hotelSettings.hotelPhone
                    };

                        const emailSent = await notificationService.sendFeedbackRequestEmail({
                            booking,
                            template,
                            additionalData
                        });
                        if (emailSent) {
                            console.log(`✅ 已發送回訪信給 ${booking.guest_name} (${booking.booking_id})`);
                        }
                    } catch (error) {
                        console.error(`❌ 發送回訪信失敗 (${booking.booking_id}):`, error.message);
                    }
                }
            }
        } catch (error) {
            console.error('❌ 回訪信任務錯誤:', error);
        }
    }

    return {
        sendPaymentReminderEmails,
        cancelExpiredReservations,
        sendCheckinReminderEmails,
        sendFeedbackRequestEmails
    };
}

module.exports = {
    createBookingNotificationJobs
};
