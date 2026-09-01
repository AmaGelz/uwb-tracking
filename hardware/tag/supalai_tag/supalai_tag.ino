/*
 * SUPALAI UWB production tag for Makerfabs ESP32 UWB / ESP32 UWB Pro.
 *
 * The DW1000 tag ranges against the three surveyed anchors, groups fresh
 * measurements every 250 ms, signs the JSON frame, and sends it to the
 * FastAPI hardware-ingest endpoint over HTTPS.
 */
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <time.h>
#include <mbedtls/md.h>
#include "DW1000Ranging.h"
#if __has_include("uwb_build_config.h")
#include "uwb_build_config.h"
#define UWB_CREDENTIALS_CONFIGURED 1
#elif __has_include("secrets.h")
#include "secrets.h"
#if __has_include("ingest_secret.h")
#ifdef UWB_INGEST_SECRET
#undef UWB_INGEST_SECRET
#endif
#include "ingest_secret.h"
#endif
#define UWB_CREDENTIALS_CONFIGURED 1
#else
#include "secrets.example.h"
#define UWB_CREDENTIALS_CONFIGURED 0
#warning "Using placeholder Wi-Fi/HMAC values. Run scripts/configure-hardware-secret.ps1 before flashing."
#endif
#include "tls_root_ca.h"

#ifndef UWB_INGEST_URL
#error "UWB_INGEST_URL is missing. Re-run scripts/configure-hardware-secret.ps1 with -ApiBaseUrl."
#endif

char TAG_ADDRESS[] = "7D:00:22:EA:82:60:3B:9C";
#define TAG_ID "TAG01"
#define GATEWAY_DEVICE_ID "SUPALAI-TAG-GW-01"
#define INGEST_URL UWB_INGEST_URL
#define ANTENNA_DELAY 16384

#define SPI_SCK 18
#define SPI_MISO 19
#define SPI_MOSI 23
const uint8_t PIN_RST = 27;
const uint8_t PIN_IRQ = 34;
const uint8_t PIN_SS = 21;

const uint32_t POST_INTERVAL_MS = 250;
const uint32_t RANGE_MAX_AGE_MS = 1200;
const uint32_t WIFI_RETRY_MS = 5000;

struct RangeSlot {
  uint16_t address;
  float distanceM;
  float rxPowerDbm;
  uint32_t seenAtMs;
  bool used;
};

RangeSlot ranges[8] = {};
uint32_t lastPostMs = 0;
uint32_t lastWifiAttemptMs = 0;
uint32_t sequenceNumber = 0;
uint32_t bootId = 0;
uint32_t successfulPostCount = 0;
QueueHandle_t frameQueue;
String ingestSecret;
bool cloudConfigured = false;
bool wifiWasConnected = false;

struct OutboundFrame {
  char json[1024];
};

void onRange();
void onNewDevice(DW1000Device *device);
void onInactiveDevice(DW1000Device *device);

String hexDigest(const uint8_t *bytes, size_t length) {
  static const char HEX_DIGITS[] = "0123456789abcdef";
  String result;
  result.reserve(length * 2);
  for (size_t i = 0; i < length; i++) {
    result += HEX_DIGITS[(bytes[i] >> 4) & 0x0F];
    result += HEX_DIGITS[bytes[i] & 0x0F];
  }
  return result;
}

String hmacSha256(const String &value) {
  uint8_t digest[32];
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_setup(&context, info, 1);
  mbedtls_md_hmac_starts(
    &context,
    reinterpret_cast<const unsigned char *>(ingestSecret.c_str()),
    ingestSecret.length()
  );
  mbedtls_md_hmac_update(&context, reinterpret_cast<const unsigned char *>(value.c_str()), value.length());
  mbedtls_md_hmac_finish(&context, digest);
  mbedtls_md_free(&context);
  return hexDigest(digest, sizeof(digest));
}

bool loadIngestSecret() {
  const String compiledSecret(UWB_INGEST_SECRET);
  if (compiledSecret.length() >= 32) {
    ingestSecret = compiledSecret;
    return true;
  }

  Preferences preferences;
  if (!preferences.begin("uwb-cloud", true)) return false;
  ingestSecret = preferences.getString("ingest", "");
  preferences.end();
  return ingestSecret.length() >= 32;
}

bool waitForIngestSecret() {
  static const String PREFIX("UWB_SECRET:");
  Serial.println("[cloud] HMAC secret missing; waiting 45 seconds for USB provisioning");
  Serial.setTimeout(1000);
  const uint32_t deadline = millis() + 45000;
  while (static_cast<int32_t>(deadline - millis()) > 0) {
    if (!Serial.available()) {
      delay(20);
      continue;
    }

    String line = Serial.readStringUntil('\n');
    line.trim();
    if (!line.startsWith(PREFIX)) continue;
    String candidate = line.substring(PREFIX.length());
    if (candidate.length() < 32) {
      Serial.println("[cloud] rejected short HMAC secret");
      continue;
    }

    Preferences preferences;
    if (!preferences.begin("uwb-cloud", false)) {
      Serial.println("[cloud] could not open NVS");
      return false;
    }
    const size_t stored = preferences.putString("ingest", candidate);
    preferences.end();
    candidate = "";
    if (stored < 32) {
      Serial.println("[cloud] could not store HMAC secret");
      return false;
    }

    Serial.println("[cloud] HMAC secret stored; restarting");
    delay(250);
    ESP.restart();
  }
  return false;
}

void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Serial.printf("[wifi] connected ip=%s\n", WiFi.localIP().toString().c_str());
    }
    return;
  }
  if (wifiWasConnected) {
    wifiWasConnected = false;
    Serial.println("[wifi] disconnected");
  }
  if (millis() - lastWifiAttemptMs < WIFI_RETRY_MS) return;
  lastWifiAttemptMs = millis();
  Serial.println("[wifi] connecting to configured network");
  WiFi.disconnect();
  WiFi.begin(UWB_WIFI_SSID, UWB_WIFI_PASSWORD);
}

bool clockReady() {
  return time(nullptr) > 1700000000;
}

String buildFrame(uint32_t nowMs, uint8_t &freshCount) {
  String list;
  freshCount = 0;
  for (RangeSlot &slot : ranges) {
    if (!slot.used || nowMs - slot.seenAtMs > RANGE_MAX_AGE_MS || slot.distanceM <= 0) continue;
    char address[5];
    snprintf(address, sizeof(address), "%04X", slot.address);
    if (freshCount++) list += ',';
    list += "{\"anchor_id\":\"";
    list += address;
    list += "\",\"distance_m\":";
    list += String(slot.distanceM, 4);
    list += ",\"rx_power_dbm\":";
    list += String(slot.rxPowerDbm, 2);
    list += '}';
  }

  sequenceNumber++;
  String messageId = String(GATEWAY_DEVICE_ID) + '-' + String(bootId, HEX) + '-' + String(sequenceNumber);
  return String("{\"message_id\":\"") + messageId
    + "\",\"tag_id\":\"" + TAG_ID
    + "\",\"ranges\":[" + list + "]}";
}

void queueFreshRanges() {
  const uint32_t nowMs = millis();
  if (nowMs - lastPostMs < POST_INTERVAL_MS) return;
  lastPostMs = nowMs;

  uint8_t count = 0;
  String payload = buildFrame(nowMs, count);
  if (count < 3) return;

  OutboundFrame frame = {};
  if (payload.length() >= sizeof(frame.json)) {
    Serial.println("[cloud] frame too large");
    return;
  }
  payload.toCharArray(frame.json, sizeof(frame.json));
  xQueueOverwrite(frameQueue, &frame);
}

void networkTask(void *parameter) {
  OutboundFrame frame;
  while (true) {
    maintainWifi();
    if (xQueueReceive(frameQueue, &frame, pdMS_TO_TICKS(250)) != pdTRUE) continue;
    if (WiFi.status() != WL_CONNECTED || !clockReady()) continue;

    const String payload(frame.json);
    const String timestamp = String(static_cast<uint32_t>(time(nullptr)));
    const String signature = hmacSha256(String(GATEWAY_DEVICE_ID) + '.' + timestamp + '.' + payload);

    WiFiClient plain;
    WiFiClientSecure tls;
    HTTPClient http;
    const String ingestUrl(INGEST_URL);
    bool connected = false;
    if (ingestUrl.startsWith("https://")) {
      // Production traffic validates the API host against its public root CA.
      tls.setCACert(UWB_ROOT_CA);
      connected = http.begin(tls, ingestUrl);
    } else if (ingestUrl.startsWith("http://")) {
      // Plain HTTP is supported only for a trusted on-site development LAN.
      // HMAC still authenticates the frame, but the payload is not encrypted.
      connected = http.begin(plain, ingestUrl);
    }
    if (!connected) continue;
    http.setTimeout(1800);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-uwb-device-id", GATEWAY_DEVICE_ID);
    http.addHeader("x-uwb-timestamp", timestamp);
    http.addHeader("x-uwb-signature", signature);
    const int status = http.POST(payload);
    if (status < 200 || status >= 300) {
      Serial.printf("[cloud] HTTP %d %s\n", status, http.getString().c_str());
    } else if ((successfulPostCount++ % 20) == 0) {
      // Keep the monitor useful without printing four successful frames/sec.
      Serial.printf("[cloud] HTTP %d ingest OK (%lu frames)\n", status, successfulPostCount);
    }
    http.end();
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  bootId = esp_random();

  frameQueue = xQueueCreate(1, sizeof(OutboundFrame));
  if (UWB_CREDENTIALS_CONFIGURED) {
    cloudConfigured = loadIngestSecret() || waitForIngestSecret();
  }
  if (cloudConfigured) {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    maintainWifi();
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    xTaskCreatePinnedToCore(networkTask, "uwb-cloud", 8192, nullptr, 1, nullptr, 0);
  } else {
    Serial.println("[cloud] NOT CONFIGURED: Wi-Fi or HMAC secret is missing");
  }

  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);
  DW1000Ranging.initCommunication(PIN_RST, PIN_SS, PIN_IRQ);
  DW1000.setAntennaDelay(ANTENNA_DELAY);
  DW1000Ranging.attachNewRange(onRange);
  DW1000Ranging.attachNewDevice(onNewDevice);
  DW1000Ranging.attachInactiveDevice(onInactiveDevice);
  DW1000Ranging.startAsTag(TAG_ADDRESS, DW1000.MODE_LONGDATA_RANGE_LOWPOWER, false);
  Serial.printf("[tag] %s device=%s interval=%lu ms\n", TAG_ID, GATEWAY_DEVICE_ID, POST_INTERVAL_MS);
}

void loop() {
  DW1000Ranging.loop();
  if (cloudConfigured) queueFreshRanges();
}

void onRange() {
  DW1000Device *device = DW1000Ranging.getDistantDevice();
  const uint16_t address = device->getShortAddress();
  RangeSlot *target = nullptr;
  for (RangeSlot &slot : ranges) {
    if (slot.used && slot.address == address) target = &slot;
    if (!target && !slot.used) target = &slot;
  }
  if (!target) return;
  target->used = true;
  target->address = address;
  target->distanceM = device->getRange();
  target->rxPowerDbm = device->getRXPower();
  target->seenAtMs = millis();
}

void onNewDevice(DW1000Device *device) {
  Serial.printf("[uwb] anchor online %04X\n", device->getShortAddress());
}

void onInactiveDevice(DW1000Device *device) {
  const uint16_t address = device->getShortAddress();
  for (RangeSlot &slot : ranges) {
    if (slot.used && slot.address == address) slot.used = false;
  }
  Serial.printf("[uwb] anchor offline %04X\n", address);
}
