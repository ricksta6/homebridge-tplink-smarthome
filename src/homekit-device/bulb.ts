import type { Categories } from 'homebridge';
import type { Bulb, LightState } from 'tplink-smarthome-api';

import HomeKitDevice from '.';
import type TplinkSmarthomePlatform from '../platform';
import {
  deferAndCombine,
  isObjectLike,
  kelvinToMired,
  miredToKelvin,
} from '../utils';

export default class HomeKitDeviceBulb extends HomeKitDevice {
  private desiredLightState: LightState = {};

  constructor(
    platform: TplinkSmarthomePlatform,
    readonly tplinkDevice: Bulb,
    readonly category: Categories
  ) {
    super(platform, tplinkDevice, category);

    this.addBasicCharacteristics();

    if (tplinkDevice.supportsBrightness) {
      this.addBrightnessCharacteristics();
    }

    if (tplinkDevice.supportsColorTemperature) {
      this.addColorTemperatureCharacteristics();
    }

    if (tplinkDevice.supportsColor) {
      this.addColorCharacteristics();
    }

    if (
      platform.config.addCustomCharacteristics &&
      tplinkDevice.supportsEmeter
    ) {
      this.addEnergyCharacteristics();
    }

    this.getLightState = deferAndCombine(() => {
      return this.tplinkDevice.lighting.getLightState();
    }, platform.config.waitTimeUpdate);

    this.setLightState = deferAndCombine(
      () => {
        if (Object.keys(this.desiredLightState).length === 0) {
          this.log.warn('setLightState called with empty desiredLightState');
          return Promise.resolve(true);
        }

        const ret = this.tplinkDevice.lighting.setLightState(
          this.desiredLightState
        );
        this.desiredLightState = {};
        return ret;
      },
      platform.config.waitTimeUpdate,
      (value: LightState) => {
        this.desiredLightState = Object.assign(this.desiredLightState, value);
      }
    );

    this.getRealtime = deferAndCombine(() => {
      return this.tplinkDevice.emeter.getRealtime();
    }, platform.config.waitTimeUpdate);
  }

  /**
   * Aggregates getLightState requests
   *
   * @private
   */
  private getLightState: () => Promise<LightState>;

  /**
   * Aggregates setLightState requests
   *
   * @private
   */
  private setLightState: (value: LightState) => Promise<true>;

  /**
   * Aggregates getRealtime requests
   *
   * @private
   */
  private getRealtime: () => Promise<unknown>;

  private addBasicCharacteristics() {
    this.addCharacteristic(this.platform.Characteristic.On, {
      getValue: async () => {
        return this.getLightState().then((ls) => {
          return !!ls.on_off;
        });
      },
      setValue: async (value) => {
        if (typeof value === 'boolean') {
          await this.setLightState({ on_off: value ? 1 : 0 });
          return;
        }
        this.log.warn('setValue: Invalid On:', value);
      },
    });
    this.tplinkDevice.on('lightstate-on', () => {
      this.fireCharacteristicUpdateCallback(
        this.platform.Characteristic.On,
        true
      );
    });
    this.tplinkDevice.on('lightstate-off', () => {
      this.fireCharacteristicUpdateCallback(
        this.platform.Characteristic.On,
        false
      );
    });

    this.tplinkDevice.on('lightstate-update', (lightState) => {
      if (lightState.on_off != null) {
        this.fireCharacteristicUpdateCallback(
          this.platform.Characteristic.On,
          lightState.on_off === 1
        );
      }
      if (lightState.brightness != null) {
        this.fireCharacteristicUpdateCallback(
          this.platform.Characteristic.Brightness,
          lightState.brightness
        );
      }
      if (lightState.color_temp != null && lightState.color_temp > 0) {
        this.fireCharacteristicUpdateCallback(
          this.platform.Characteristic.ColorTemperature,
          Math.round(kelvinToMired(lightState.color_temp))
        );
        this.fireCharacteristicUpdateCallback(
          this.platform.Characteristic.Hue,
          0
        );
        this.fireCharacteristicUpdateCallback(
          this.platform.Characteristic.Saturation,
          0
        );
      } else {
        let hueOrSatChanged = false;
        if (lightState.hue != null) {
          hueOrSatChanged = true;
          this.fireCharacteristicUpdateCallback(
            this.platform.Characteristic.Hue,
            lightState.hue
          );
        }
        if (lightState.Saturation != null) {
          hueOrSatChanged = true;
          this.fireCharacteristicUpdateCallback(
            this.platform.Characteristic.Saturation,
            lightState.Saturation
          );
        }
        if (hueOrSatChanged) {
          this.fireCharacteristicUpdateCallback(
            this.platform.Characteristic.ColorTemperature,
            0
          );
        }
      }
    });
  }

  private addBrightnessCharacteristics() {
    this.addCharacteristic(this.platform.Characteristic.Brightness, {
      getValue: async () => {
        return this.getLightState().then((ls) => {
          return ls.brightness;
        });
      },
      setValue: async (value) => {
        if (typeof value === 'number') {
          await this.setLightState({ brightness: value });
          return;
        }
        this.log.warn('setValue: Invalid Brightness:', value);
      },
    });
  }

  private addColorTemperatureCharacteristics() {
    const range = this.tplinkDevice.getColorTemperatureRange;
    if (range == null) {
      this.log.error('Could not retrieve color temperature range');
      return;
    }

    const { min, max } = range;

    this.addCharacteristic(this.platform.Characteristic.ColorTemperature, {
      props: {
        minValue: Math.ceil(kelvinToMired(max)), // K and Mired are reversed
        maxValue: Math.floor(kelvinToMired(min)), // K and Mired are reversed
      },
      getValue: async () => {
        const ls = await this.getLightState();
        if (typeof ls.color_temp === 'number') {
          return Math.round(kelvinToMired(ls.color_temp));
        }
        if (!('color_temp' in ls)) {
          return null;
        }
        this.log.warn('getValue: Invalid ColorTemperature:', ls.color_temp);
        return null;
      },
      setValue: async (value) => {
        if (typeof value === 'number') {
          await this.setLightState({
            color_temp: Math.round(miredToKelvin(value)),
          });
          return;
        }
        this.log.warn('setValue: Invalid ColorTemperature:', value);
      },
    });
  }

  private addColorCharacteristics() {
    this.addCharacteristic(this.platform.Characteristic.Hue, {
      getValue: async () => {
        const ls = await this.getLightState();
        return ls.hue;
      },
      setValue: async (value) => {
        if (typeof value === 'number') {
          await this.setLightState({ hue: value, color_temp: 0 });
          return;
        }
        this.log.warn('setValue: Invalid Hue:', value);
      },
    });

    this.addCharacteristic(this.platform.Characteristic.Saturation, {
      getValue: async () => {
        return this.getLightState().then((ls) => {
          return ls.saturation;
        });
      },
      setValue: async (value) => {
        if (typeof value === 'number') {
          await this.setLightState({ saturation: value, color_temp: 0 });
          return;
        }
        this.log.warn('setValue: Invalid Saturation:', value);
      },
    });
  }

  private addEnergyCharacteristics() {
    this.addCharacteristic(this.platform.customCharacteristics.Watts, {
      getValue: async () => {
        const emeterRealtime = await this.getRealtime();
        if (isObjectLike(emeterRealtime)) {
          if (typeof emeterRealtime.power === 'number') {
            return emeterRealtime.power;
          }
          this.log.warn(`getValue: Invalid Watts:`, emeterRealtime.power);
          return null;
        }
        this.log.warn(`getValue: Invalid Watts:`, typeof emeterRealtime);
        return null;
      },
    });

    this.tplinkDevice.on('emeter-realtime-update', (emeterRealtime) => {
      this.fireCharacteristicUpdateCallback(
        this.platform.customCharacteristics.Watts,
        emeterRealtime.power
      );
    });
  }

  identify(): void {
    this.log.debug(`[${this.name}] identify`);
    this.log.warn(`[${this.name}] identify, not implemented`);
  }
}
