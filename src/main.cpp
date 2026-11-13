#include <Arduino.h>
#include <ArduinoJson.h>
#include <DHTesp.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "secrets.h"

namespace Config {
constexpr uint8_t ZONE_COUNT = 6;
constexpr uint8_t NODE_COUNT = 8;
constexpr uint8_t EXIT_COUNT = 2;
constexpr uint8_t EDGE_COUNT = 8;

constexpr uint8_t DHT_PINS[ZONE_COUNT] = {13, 14, 25, 26, 27, 32};
constexpr uint8_t MUX_SELECT_PINS[4] = {16, 17, 18, 19};
constexpr uint8_t MUX_SIGNAL_PIN = 34;  // ADC1: hoạt động cả khi Wi-Fi bật.
// Hai CD74HC4067 quét 14 LED: mux #2 giữ LED 1-9, mux #3 giữ LED 10-14.
// Hai mux dùng chung 4 chân chọn kênh, mỗi mux có một chân SIG riêng.
constexpr uint8_t LED_SELECT_PINS[4] = {21, 22, 23, 33};
constexpr uint8_t LED_SIG_PINS[2] = {4, 5};
constexpr uint8_t LED_MUX_COUNT = 2;
constexpr uint8_t LED_PER_MUX = 9;
constexpr uint8_t LED_COUNT = 14;  // Mỗi chiều đi vào tòa nhà một LED; bỏ chiều từ cửa thoát vào trong.

constexpr float FIRE_TEMP_C = 55.0F;
constexpr float SAFE_TEMP_C = 48.0F;
constexpr uint16_t FIRE_SMOKE_ADC = 2500;
constexpr uint16_t SAFE_SMOKE_ADC = 2200;
constexpr uint8_t FIRE_CONFIRM_SAMPLES = 3;
constexpr uint8_t SAFE_CONFIRM_SAMPLES = 5;
constexpr uint32_t SENSOR_INTERVAL_MS = 1000;
constexpr uint32_t DHT_INTERVAL_MS = 2000;
constexpr uint32_t CLOUD_INTERVAL_MS = 15000;
constexpr uint32_t MQ2_WARMUP_MS = 20000;
constexpr uint16_t INF = 30000;
}  // namespace Config

enum Node : uint8_t { A, B, C, D, E, F, G1, G2 };
const char* NODE_NAMES[Config::NODE_COUNT] = {"A", "B", "C", "D", "E", "F", "G1", "G2"};

struct Edge {
  Node from;
  Node to;
  uint8_t cost;
};

// Topology dùng chung với dashboard, theo docs/so_do_demo.jpg.
// Thứ tự cạnh cũng quyết định thứ tự 14 LED trong updateLeds()/docs/WIRING.md.
constexpr Edge EDGES[Config::EDGE_COUNT] = {
    {A, C, 2}, {B, C, 2}, {B, D, 2}, {C, E, 2},
    {D, E, 2}, {D, F, 2}, {A, G1, 1}, {F, G2, 1},
};
static_assert(Config::LED_COUNT == 2 * Config::EDGE_COUNT - Config::EXIT_COUNT,
              "So LED phai bang 2 * so canh - so canh cua thoat");

struct ZoneData {
  float temperature = 25.0F;
  float humidity = 0.0F;
  uint16_t smoke = 0;
  bool dhtOk = false;
  bool fire = false;
  uint8_t dangerSamples = 0;
  uint8_t safeSamples = 0;
  String historyKey;
};

struct Route {
  enum Status : uint8_t { AVAILABLE, FIRE, NO_PATH } status = NO_PATH;
  Node exit = G1;
  uint16_t cost = Config::INF;
  Node nodes[Config::NODE_COUNT]{};
  uint8_t length = 0;
};

DHTesp dht[Config::ZONE_COUNT];
volatile bool ledOn[Config::LED_COUNT]{};
ZoneData zones[Config::ZONE_COUNT];
Route routes[Config::ZONE_COUNT];
bool manualFire[Config::ZONE_COUNT]{};
bool manualMode = false;
bool routesDirty = true;
uint32_t lastSensorRead = 0;
uint32_t lastDhtRead = 0;
uint32_t lastCloudWrite = 0;

bool isExit(Node node) { return node == G1 || node == G2; }
bool isBlocked(Node node) { return node < Config::ZONE_COUNT && zones[node].fire; }

uint16_t readMux(uint8_t channel) {
  for (uint8_t bit = 0; bit < 4; ++bit) {
    digitalWrite(Config::MUX_SELECT_PINS[bit], (channel >> bit) & 1U);
  }
  delayMicroseconds(80);
  analogRead(Config::MUX_SIGNAL_PIN);  // Bỏ mẫu đầu sau khi chuyển kênh.
  delayMicroseconds(80);
  return analogRead(Config::MUX_SIGNAL_PIN);
}

void calculateRoute(Node start, Route& result) {
  result = Route{};

  uint16_t distance[Config::NODE_COUNT];
  int8_t previous[Config::NODE_COUNT];
  bool visited[Config::NODE_COUNT]{};
  for (uint8_t i = 0; i < Config::NODE_COUNT; ++i) {
    distance[i] = Config::INF;
    previous[i] = -1;
  }
  distance[start] = 0;

  for (uint8_t step = 0; step < Config::NODE_COUNT; ++step) {
    int8_t current = -1;
    uint16_t best = Config::INF;
    for (uint8_t node = 0; node < Config::NODE_COUNT; ++node) {
      const Node candidateNode = static_cast<Node>(node);
      if (!visited[node] && (!isBlocked(candidateNode) || candidateNode == start) && distance[node] < best) {
        best = distance[node];
        current = node;
      }
    }
    if (current < 0) break;
    visited[current] = true;

    for (const Edge& edge : EDGES) {
      int8_t next = -1;
      if (edge.from == current) next = edge.to;
      if (edge.to == current) next = edge.from;
      if (next < 0 || isBlocked(static_cast<Node>(next))) continue;
      const uint16_t candidate = distance[current] + edge.cost;
      if (candidate < distance[next]) {
        distance[next] = candidate;
        previous[next] = current;
      }
    }
  }

  Node chosenExit = distance[G1] <= distance[G2] ? G1 : G2;
  if (distance[chosenExit] >= Config::INF) {
    result.status = Route::NO_PATH;
    return;
  }

  Node reversed[Config::NODE_COUNT];
  uint8_t count = 0;
  int8_t cursor = chosenExit;
  while (cursor >= 0 && count < Config::NODE_COUNT) {
    reversed[count++] = static_cast<Node>(cursor);
    if (cursor == start) break;
    cursor = previous[cursor];
  }
  if (count == 0 || reversed[count - 1] != start) return;

  // FIRE vẫn mang một route: người trong chính zone cháy phải được hướng dẫn đi ra.
  result.status = isBlocked(start) ? Route::FIRE : Route::AVAILABLE;
  result.exit = chosenExit;
  result.cost = distance[chosenExit];
  result.length = count;
  for (uint8_t i = 0; i < count; ++i) result.nodes[i] = reversed[count - i - 1];
}

void calculateAllRoutes() {
  for (uint8_t zone = 0; zone < Config::ZONE_COUNT; ++zone) {
    calculateRoute(static_cast<Node>(zone), routes[zone]);
  }
  routesDirty = true;
}

bool routeUsesDirection(Node from, Node to) {
  for (const Route& route : routes) {
    if (route.status == Route::NO_PATH) continue;
    for (uint8_t i = 1; i < route.length; ++i) {
      if (route.nodes[i - 1] == from && route.nodes[i] == to) return true;
    }
  }
  return false;
}

// LED sáng = chiều đó được đi; tắt = không được đi.
// Thứ tự LED khớp bảng trong docs/WIRING.md.
void updateLeds() {
  uint8_t led = 0;
  for (uint8_t i = 0; i < Config::EDGE_COUNT; ++i) {
    const Edge& edge = EDGES[i];
    ledOn[led++] = routeUsesDirection(edge.from, edge.to);
    // Không cần mũi tên đi từ cửa thoát ngược vào tòa nhà.
    if (!isExit(edge.to)) ledOn[led++] = routeUsesDirection(edge.to, edge.from);
  }
  routesDirty = false;
}

// Chạy ở core 0: lần lượt chọn từng kênh và cấp tín hiệu cho LED của kênh đó.
void ledScanTask(void*) {
  for (;;) {
    for (uint8_t channel = 0; channel < Config::LED_PER_MUX; ++channel) {
      for (uint8_t mux = 0; mux < Config::LED_MUX_COUNT; ++mux) digitalWrite(Config::LED_SIG_PINS[mux], LOW);
      for (uint8_t bit = 0; bit < 4; ++bit) digitalWrite(Config::LED_SELECT_PINS[bit], (channel >> bit) & 1U);
      delayMicroseconds(5);
      for (uint8_t mux = 0; mux < Config::LED_MUX_COUNT; ++mux) {
        const uint8_t led = mux * Config::LED_PER_MUX + channel;
        if (led < Config::LED_COUNT && ledOn[led]) digitalWrite(Config::LED_SIG_PINS[mux], HIGH);
      }
      vTaskDelay(1);
    }
  }
}

bool firebaseConfigured() {
  return strlen(WIFI_SSID) > 0 && strlen(FIREBASE_DATABASE_URL) > 8;
}

String firebaseUrl(const String& path) {
  String url = String(FIREBASE_DATABASE_URL) + path + ".json";
  if (strlen(FIREBASE_AUTH) > 0) url += "?auth=" + String(FIREBASE_AUTH);
  return url;
}

int firebaseRequest(const char* method, const String& path, const String& body, String* response = nullptr) {
  if (WiFi.status() != WL_CONNECTED || !firebaseConfigured()) return -1;
  WiFiClientSecure client;
  client.setInsecure();  // Phù hợp prototype; production nên ghim CA certificate.
  HTTPClient http;
  if (!http.begin(client, firebaseUrl(path))) return -1;
  http.addHeader("Content-Type", "application/json");
  const int status = http.sendRequest(method, body);
  if (response) *response = http.getString();
  http.end();
  return status;
}

void openFireHistory(uint8_t zone) {
  JsonDocument doc;
  doc["zone"] = NODE_NAMES[zone];
  doc["time_start"][".sv"] = "timestamp";
  doc["time_end"] = nullptr;
  String body, response;
  serializeJson(doc, body);
  const int status = firebaseRequest("POST", "/fireHistory", body, &response);
  if (status >= 200 && status < 300) {
    JsonDocument result;
    if (deserializeJson(result, response) == DeserializationError::Ok) {
      zones[zone].historyKey = result["name"].as<String>();
    }
  }
}

void closeFireHistory(uint8_t zone) {
  if (zones[zone].historyKey.isEmpty()) return;
  JsonDocument doc;
  doc["time_end"][".sv"] = "timestamp";
  String body;
  serializeJson(doc, body);
  firebaseRequest("PATCH", "/fireHistory/" + zones[zone].historyKey, body);
  zones[zone].historyKey = "";
}

void setFireState(uint8_t zone, bool fire) {
  if (zones[zone].fire == fire) return;
  zones[zone].fire = fire;
  if (fire) openFireHistory(zone); else closeFireHistory(zone);
  calculateAllRoutes();
  lastCloudWrite = 0;  // Gửi ngay ở vòng lặp kế tiếp.
  Serial.printf("[ALARM] Zone %s -> %s\n", NODE_NAMES[zone], fire ? "FIRE" : "SAFE");
}

void evaluateZone(uint8_t zone, bool smokeReady) {
  if (manualMode) {
    setFireState(zone, manualFire[zone]);
    return;
  }
  const bool danger = zones[zone].temperature >= Config::FIRE_TEMP_C ||
                      (smokeReady && zones[zone].smoke >= Config::FIRE_SMOKE_ADC);
  const bool safe = zones[zone].temperature < Config::SAFE_TEMP_C &&
                    (!smokeReady || zones[zone].smoke < Config::SAFE_SMOKE_ADC);

  zones[zone].dangerSamples = danger ? (zones[zone].dangerSamples < 20 ? zones[zone].dangerSamples + 1 : 20) : 0;
  zones[zone].safeSamples = safe ? (zones[zone].safeSamples < 20 ? zones[zone].safeSamples + 1 : 20) : 0;
  if (!zones[zone].fire && zones[zone].dangerSamples >= Config::FIRE_CONFIRM_SAMPLES) setFireState(zone, true);
  if (zones[zone].fire && zones[zone].safeSamples >= Config::SAFE_CONFIRM_SAMPLES) setFireState(zone, false);
}

void readSensors() {
  const uint32_t now = millis();
  const bool smokeReady = now >= Config::MQ2_WARMUP_MS;
  // DHT11 cần tối thiểu 1 giây; một số module trong bộ chỉ ổn định ở 2 giây.
  const bool readDht = now - lastDhtRead >= Config::DHT_INTERVAL_MS;
  if (readDht) lastDhtRead = now;
  for (uint8_t zone = 0; zone < Config::ZONE_COUNT; ++zone) {
    if (readDht) {
      const TempAndHumidity reading = dht[zone].getTempAndHumidity();
      const bool dhtOk = dht[zone].getStatus() == 0 && !isnan(reading.temperature) &&
                         !isnan(reading.humidity);
      if (dhtOk) {
        zones[zone].temperature = reading.temperature;
        zones[zone].humidity = reading.humidity;
      }
      zones[zone].dhtOk = dhtOk;
    }
    zones[zone].smoke = readMux(zone);
    evaluateZone(zone, smokeReady);
    Serial.printf("%s: %.1f C, %.1f %%, smoke=%u, fire=%d, dht=%d\n", NODE_NAMES[zone],
                  zones[zone].temperature, zones[zone].humidity, zones[zone].smoke,
                  zones[zone].fire, zones[zone].dhtOk ? 1 : 0);
  }
}

const char* routeStatusName(Route::Status status) {
  if (status == Route::AVAILABLE) return "AVAILABLE";
  if (status == Route::FIRE) return "FIRE";
  return "NO_PATH";
}

void uploadCurrentState() {
  JsonDocument doc;
  bool anyFire = false;
  for (const ZoneData& zone : zones) anyFire |= zone.fire;
  doc["system"]["status"] = anyFire ? "FIRE" : "SAFE";
  doc["system"]["lastUpdated"][".sv"] = "timestamp";

  for (uint8_t zone = 0; zone < Config::ZONE_COUNT; ++zone) {
    JsonObject item = doc["zones"][NODE_NAMES[zone]].to<JsonObject>();
    if (zones[zone].dhtOk) {
      item["temperature"] = serialized(String(zones[zone].temperature, 1));
      item["humidity"] = serialized(String(zones[zone].humidity, 1));
    } else {
      item["temperature"] = nullptr;
      item["humidity"] = nullptr;
    }
    item["smoke"] = zones[zone].smoke;
    item["fire"] = zones[zone].fire;

    JsonObject routeJson = doc["routes"][NODE_NAMES[zone]].to<JsonObject>();
    routeJson["status"] = routeStatusName(routes[zone].status);
    if (routes[zone].status != Route::NO_PATH && routes[zone].length > 1) {
      routeJson["exit"] = NODE_NAMES[routes[zone].exit];
      routeJson["cost"] = routes[zone].cost;
      JsonArray path = routeJson["nodes"].to<JsonArray>();
      for (uint8_t i = 0; i < routes[zone].length; ++i) path.add(NODE_NAMES[routes[zone].nodes[i]]);
    } else {
      routeJson["exit"] = nullptr;
      routeJson["cost"] = nullptr;
      routeJson["nodes"].to<JsonArray>();
    }
  }

  String payload;
  serializeJson(doc, payload);
  const int status = firebaseRequest("PUT", "/current", payload);
  Serial.printf("[Firebase] PUT /current -> %d\n", status);
}

void handleSerialCommand() {
  if (!Serial.available()) return;
  String command = Serial.readStringUntil('\n');
  command.trim();
  command.toUpperCase();
  if (command == "AUTO") {
    manualMode = false;
    Serial.println("Che do cam bien tu dong");
  } else if (command == "CLEAR") {
    manualMode = true;
    for (uint8_t i = 0; i < Config::ZONE_COUNT; ++i) manualFire[i] = false;
    Serial.println("Da xoa canh bao mo phong");
  } else if (command.startsWith("FIRE ") && command.length() == 6) {
    const char id = command.charAt(5);
    if (id >= 'A' && id <= 'F') {
      manualMode = true;
      manualFire[id - 'A'] = true;
      Serial.printf("Mo phong chay tai %c\n", id);
    }
  } else {
    Serial.println("Lenh: FIRE A..F | CLEAR | AUTO");
  }
}

void connectWifi() {
  if (!firebaseConfigured()) {
    Serial.println("[WiFi] Chua cau hinh include/secrets.h; chay offline.");
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] Connecting");
  for (uint8_t i = 0; i < 30 && WiFi.status() != WL_CONNECTED; ++i) {
    delay(300);
    Serial.print('.');
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " timeout; offline mode");
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  for (uint8_t pin : Config::MUX_SELECT_PINS) pinMode(pin, OUTPUT);
  for (uint8_t zone = 0; zone < Config::ZONE_COUNT; ++zone) dht[zone].setup(Config::DHT_PINS[zone], DHTesp::DHT11);
  for (uint8_t pin : Config::LED_SELECT_PINS) pinMode(pin, OUTPUT);
  for (uint8_t pin : Config::LED_SIG_PINS) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }
  calculateAllRoutes();
  updateLeds();
  xTaskCreatePinnedToCore(ledScanTask, "ledScan", 2048, nullptr, 1, nullptr, 0);
  connectWifi();
  Serial.println("FireRoute ready. Lenh demo: FIRE B, CLEAR, AUTO");
}

void loop() {
  handleSerialCommand();
  if (WiFi.getMode() == WIFI_STA && WiFi.status() != WL_CONNECTED && firebaseConfigured()) WiFi.reconnect();

  const uint32_t now = millis();
  if (now - lastSensorRead >= Config::SENSOR_INTERVAL_MS) {
    lastSensorRead = now;
    readSensors();
  }
  if (routesDirty) updateLeds();
  if (lastCloudWrite == 0 || now - lastCloudWrite >= Config::CLOUD_INTERVAL_MS) {
    lastCloudWrite = now;
    uploadCurrentState();
  }
  delay(10);
}
