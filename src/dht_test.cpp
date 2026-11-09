#include <Arduino.h>
#include <DHTesp.h>

namespace {
constexpr uint8_t SENSOR_COUNT = 6;
constexpr uint8_t DHT_PINS[SENSOR_COUNT] = {13, 14, 25, 26, 27, 32};
constexpr const char* ZONE_NAMES[SENSOR_COUNT] = {"A", "B", "C", "D", "E", "F"};
constexpr uint32_t READ_INTERVAL_MS = 2500;

DHTesp sensors[SENSOR_COUNT];
uint32_t lastRead = 0;

void printReading(uint8_t index) {
  const TempAndHumidity value = sensors[index].getTempAndHumidity();
  Serial.printf("Zone %s | GPIO %u | ", ZONE_NAMES[index], DHT_PINS[index]);
  if (sensors[index].getStatus() != 0 || isnan(value.temperature) || isnan(value.humidity)) {
    Serial.printf("KHONG DOC DUOC (%s)\n", sensors[index].getStatusString());
    return;
  }
  Serial.printf("Nhiet do: %.1f C | Do am: %.1f %%\n", value.temperature, value.humidity);
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("=== FireRoute: kiem tra DHT11 ===");
  Serial.println("A=GPIO13 B=GPIO14 C=GPIO25 D=GPIO26 E=GPIO27 F=GPIO32");
  for (uint8_t index = 0; index < SENSOR_COUNT; ++index) {
    sensors[index].setup(DHT_PINS[index], DHTesp::DHT11);
  }
}

void loop() {
  const uint32_t now = millis();
  if (now - lastRead < READ_INTERVAL_MS) return;
  lastRead = now;
  Serial.println("----------------------------------------");
  for (uint8_t index = 0; index < SENSOR_COUNT; ++index) {
    printReading(index);
  }
}

