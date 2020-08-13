let Service, Characteristic;

const InfluxDB = require('influx');

const defaultConfig = {
    sensor_names: {
        temperature: 'Temperature Sensor',
        humidity: 'Humidity Sensor',
        air_quality: 'Air Quality Sensor'
    },
    schema: {
        temperature: { field: 'temperature', measurement: 'air' },
        humidity: { field: 'humidity', measurement: 'air' },
        air_quality: { fields: { pm2_5: 'pm25', pm10: 'pm100' }, measurement: 'pm' }
    },
    air_quality_rating: {
        EXCELLENT: { max_pm10: 15, max_pm2_5: 10 },
        GOOD: { max_pm10: 30, max_pm2_5: 15 },
        FAIR: { max_pm10: 50, max_pm2_5: 25 },
        INFERIOR: { max_pm10: 70, max_pm2_5: 35 }
    }
};

const getLastMesurement = (influx, service, schema, cb) => {
    // InfluxDB queries for each service
    if (service == 'temperature') {
        influx
            .query(`SELECT LAST("${schema.temperature.field}") FROM ${schema.temperature.measurement}`)
            .then(result => cb(null, result[0].last))
            .catch(err => cb(err));
    } else if (service === 'humidity') {
        influx
            .query(`SELECT LAST("${schema.humidity.field}") FROM "${schema.humidity.measurement}"`)
            .then(result => cb(null, result[0].last))
            .catch(err => cb(err));
    } else if (service === 'air_quality') {
        influx
            .query(
                `SELECT LAST("${schema.air_quality.fields.pm10}") AS "pm100", LAST(${schema.air_quality.fields.pm2_5}) AS "pm25" FROM ${schema.air_quality.measurement}`
            )
            .then(result => cb(null, { pm100: result[0].pm100, pm25: result[0].pm25 }))
            .catch(err => cb(err));
    }
};

const round = (value, decimal = 0) => {
    // Round up the value to meet the minStep - https://stackoverflow.com/a/11832950
    return Math.round((value + Number.EPSILON) * 10 ** decimal) / 10 ** decimal;
};

const getAirQuality = (value, airQualityRating) => {
    // Caculate air quality based on value.pm100, value.pm25, and the configured range
    if (typeof value === 'undefined' || typeof value.pm100 === 'undefined' || typeof value.pm25 === 'undefined') {
        return Characteristic.AirQuality.UNKNOWN;
    }

    let pm100 = value.pm100;
    let pm25 = value.pm25;

    if (!pm100 || !pm25) {
        return Characteristic.AirQuality.UNKNOWN;
    }

    if (pm100 < airQualityRating.EXCELLENT.max_pm10 && pm25 < airQualityRating.EXCELLENT.max_pm2_5) {
        return Characteristic.AirQuality.EXCELLENT;
    } else if (pm100 < airQualityRating.GOOD.max_pm10 && pm25 < airQualityRating.GOOD.max_pm2_5) {
        return Characteristic.AirQuality.GOOD;
    } else if (pm100 < airQualityRating.FAIR.max_pm10 && pm25 < airQualityRating.FAIR.max_pm2_5) {
        return Characteristic.AirQuality.FAIR;
    } else if (pm100 < airQualityRating.INFERIOR.max_pm10 && pm25 < airQualityRating.INFERIOR.max_pm2_5) {
        return Characteristic.AirQuality.INFERIOR;
    } else {
        // Inferred definition of poor air quality
        return Characteristic.AirQuality.POOR;
    }
};

module.exports = homebridge => {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory('homebridge-influx-air', 'InfluxAir', HttpInfluxAir);
};

function HttpInfluxAir(log, config) {
    this.log = log;

    // Configuration
    this.name = config['name'];
    this.manufacturer = config['manufacturer'] || 'Home';
    this.model = config['model'] || 'InfluxDB';
    this.serial = config['serial'] || '1';

    this.sensor_names = { ...defaultConfig['sensor_names'], ...config['sensor_names'] };
    this.schema = { ...defaultConfig['schema'], ...config['schema'] };
    this.airQualityRating = { ...defaultConfig['air_quality_rating'], ...config['air_quality_rating'] };

    this.influx = new InfluxDB.InfluxDB({ ...config['influx'] });
}

HttpInfluxAir.prototype = {
    // Called when HomeKit wants to read our sensor value.
    getRemoteState: function (service, callback) {
        getLastMesurement(
            this.influx,
            service,
            this.schema,
            function (influxError, value) {
                if (service === 'temperature') {
                    if (influxError) {
                        this.log(influxError);
                        return callback(new Error(influxError));
                    }
                    let v = round(value, 1);
                    this.temperatureService.setCharacteristic(Characteristic.Name, this.sensor_names.temperature);
                    this.temperatureService.setCharacteristic(Characteristic.CurrentTemperature, v);
                    return callback(null, v);
                } else if (service === 'humidity') {
                    if (influxError) {
                        this.log(influxError);
                        return callback(new Error(influxError));
                    }
                    let v = round(value);
                    this.humidityService.setCharacteristic(Characteristic.Name, this.sensor_names.humidity);
                    this.humidityService.setCharacteristic(Characteristic.CurrentRelativeHumidity, v);
                    return callback(null, v);
                } else if (service === 'air_quality') {
                    if (influxError) {
                        this.log(influxError);
                        return callback(null, Characteristic.AirQuality.UNKNOWN);
                    }
                    let quality = getAirQuality(value, this.airQualityRating);
                    this.airQualityService.setCharacteristic(Characteristic.Name, this.sensor_names.air_quality);
                    this.airQualityService.setCharacteristic(Characteristic.AirQuality, quality);
                    this.airQualityService.setCharacteristic(Characteristic.PM2_5Density, round(value.pm25));
                    this.airQualityService.setCharacteristic(Characteristic.PM10Density, round(value.pm100));
                    return callback(null, quality);
                }

                return callback(new Error(`Unknown service ${service}`));
            }.bind(this)
        );
    },

    // Homekit-specific getters
    getTemperatureState: function (callback) {
        this.getRemoteState('temperature', callback);
    },
    getHumidityState: function (callback) {
        this.getRemoteState('humidity', callback);
    },
    getAirQualityState: function (callback) {
        this.getRemoteState('air_quality', callback);
    },

    // Service configuration
    // Sets up all the capacities of the accessory, as well as the AccessoryInformation, which provides basic identification for our accessory.
    getServices: function () {
        const informationService = new Service.AccessoryInformation();

        this.temperatureService = new Service.TemperatureSensor(this.name);
        this.humidityService = new Service.HumiditySensor(this.name);
        this.airQualityService = new Service.AirQualitySensor(this.name);

        informationService
            .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
            .setCharacteristic(Characteristic.Model, this.model)
            .setCharacteristic(Characteristic.SerialNumber, this.serial);

        this.temperatureService
            .getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: -273, maxValue: 200 })
            .on('get', this.getTemperatureState.bind(this));

        this.humidityService
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .setProps({ minValue: 0, maxValue: 100 })
            .on('get', this.getHumidityState.bind(this));

        this.airQualityService
            .getCharacteristic(Characteristic.AirQuality)
            .setProps({ minValue: 0, maxValue: 5 })
            .on('get', this.getAirQualityState.bind(this));

        return [informationService, this.temperatureService, this.humidityService, this.airQualityService];
    }
};
