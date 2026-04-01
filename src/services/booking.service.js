function createBookingService(deps) {
    const { db } = deps;

    async function getBookings(startDate, endDate, buildingId, bookingMode, tenantId) {
        if (startDate && endDate) {
            console.log('📅 查詢日曆區間:', startDate, '~', endDate);
            return db.getBookingsInRange(startDate, endDate, buildingId, bookingMode, tenantId);
        }
        console.log('📋 查詢所有訂房記錄');
        return db.getAllBookings(buildingId, bookingMode, tenantId);
    }

    async function getBookingById(bookingId, tenantId) {
        return db.getBookingById(bookingId, tenantId);
    }

    async function getBookingsByEmail(email, bookingMode, tenantId) {
        return db.getBookingsByEmail(email, bookingMode, tenantId);
    }

    async function getCurrentSystemMode(tenantId) {
        const mode = ((await db.getSetting('system_mode', tenantId)) || 'retail').toString().trim();
        return ['retail', 'whole_property'].includes(mode) ? mode : 'retail';
    }

    function addBookingDefaults(bookings = []) {
        return bookings.map((booking) => ({
            ...booking,
            payment_status: booking.payment_status || 'pending',
            status: booking.status || 'active'
        }));
    }

    return {
        getBookings,
        getBookingById,
        getBookingsByEmail,
        getCurrentSystemMode,
        addBookingDefaults
    };
}

module.exports = {
    createBookingService
};
