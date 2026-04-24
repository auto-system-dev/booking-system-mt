function createHotelConfigService(deps) {
    const {
        db
    } = deps;
    const defaultTenantId = parseInt(process.env.DEFAULT_TENANT_ID || '1', 10);

    const DEFAULT_HOTEL_SETTINGS = {
        name: 'XX旅宿',
        // Contact fields should stay empty when tenant has not configured them.
        phone: '',
        address: '台北市信義區信義路五段7號',
        email: ''
    };

    async function getHotelSettingsWithFallback(tenantId = defaultTenantId) {
        const safeTenantId = Number.isInteger(parseInt(tenantId, 10)) && parseInt(tenantId, 10) > 0
            ? parseInt(tenantId, 10)
            : defaultTenantId;
        const hotelName = ((await db.getSetting('hotel_name', safeTenantId)) || '').trim() || DEFAULT_HOTEL_SETTINGS.name;
        const hotelPhone = ((await db.getSetting('hotel_phone', safeTenantId)) || '').trim() || DEFAULT_HOTEL_SETTINGS.phone;
        const hotelAddress = ((await db.getSetting('hotel_address', safeTenantId)) || '').trim() || DEFAULT_HOTEL_SETTINGS.address;
        const hotelEmail = ((await db.getSetting('hotel_email', safeTenantId)) || '').trim() || DEFAULT_HOTEL_SETTINGS.email;
        return { hotelName, hotelPhone, hotelAddress, hotelEmail };
    }

    return {
        getHotelSettingsWithFallback
    };
}

module.exports = {
    createHotelConfigService
};
