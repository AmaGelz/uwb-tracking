/*

DW1000 antenna delay calibration jig -- ANCHOR side.
See CALIBRATION.md for the full procedure. This is a TEMPORARY sketch: flash
it onto ONE physical anchor board for the duration of a calibration session,
then reflash that board with its real anchor_17XX.ino (with the resulting
calibrated ANTENNA_DELAY filled in) before returning it to the field.

Convention used here (see CALIBRATION.md for why):
  - The TAG stays at the library default antenna delay (16384) for the
    entire session -- see calib_tag.ino, which is never changed during
    calibration.
  - EACH ANCHOR is calibrated INDIVIDUALLY against that fixed tag by varying
    ANTENNA_DELAY below between trials and comparing the printed running
    average range against a taped/laser-measured true distance.
  - Anchors are NOT interchangeable -- anchor_1782/1783/1784 will each get
    their OWN calibrated value in the end. Repeat this whole procedure once
    per anchor: set ANCHOR_ADD below to that anchor's real address (see
    MAPPING.md) before starting its session.

Structure/pins copied verbatim from anchor_1782.ino -- only the antenna
delay define/call and the averaging print in newRange() are new.
*/

#include <SPI.h>
#include "DW1000Ranging.h"

// Set this to the real ANCHOR_ADD of whichever anchor board you are
// calibrating right now (see MAPPING.md for the 3 real addresses).
#define ANCHOR_ADD "83:17:5B:D5:A9:9A:E2:9C"

// ---- THE ONLY VALUE YOU SHOULD NEED TO CHANGE BETWEEN TRIALS ----
// Trial 1: leave at the library default (16384). Follow CALIBRATION.md's
// two-point procedure to pick trial 2's value and then the final value.
#define ANTENNA_DELAY 16819

#define SPI_SCK 18
#define SPI_MISO 19
#define SPI_MOSI 23
#define DW_CS 4

// connection pins
const uint8_t PIN_RST = 27; // reset pin
const uint8_t PIN_IRQ = 34; // irq pin
const uint8_t PIN_SS = 21;  // spi select pin

// Running-average window so you have a stable number to eyeball, not just a
// noisy single sample. See CALIBRATION.md for how many samples to let this
// settle for before reading it off (roughly AVG_WINDOW worth).
#define AVG_WINDOW 10
float rangeBuffer[AVG_WINDOW];
uint8_t rangeIndex = 0;
uint8_t rangeCount = 0;

void setup()
{
    Serial.begin(115200);
    delay(1000);
    //init the configuration
    SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);
    DW1000Ranging.initCommunication(PIN_RST, PIN_SS, PIN_IRQ); //Reset, CS, IRQ pin

    // Must be called after initCommunication() and before startAsAnchor():
    // antenna delay is only written to the physical chip inside
    // commitConfiguration(), which startAsAnchor() triggers internally.
    // Calling this any later would silently do nothing (or fall back to
    // the 16384 default).
    DW1000.setAntennaDelay(ANTENNA_DELAY);

    DW1000Ranging.attachNewRange(newRange);
    DW1000Ranging.attachBlinkDevice(newBlink);
    DW1000Ranging.attachInactiveDevice(inactiveDevice);

    //we start the module as an anchor
    DW1000Ranging.startAsAnchor(ANCHOR_ADD, DW1000.MODE_LONGDATA_RANGE_LOWPOWER, false);
    Serial.println("[calib_anchor] antenna delay calibration jig");
    Serial.print("[calib_anchor] ANCHOR_ADD=");
    Serial.print(ANCHOR_ADD);
    Serial.print("  ANTENNA_DELAY=");
    Serial.println(ANTENNA_DELAY);
}

void loop()
{
    DW1000Ranging.loop();
}

// Outlier bound for the median filter below, in meters -- matches the
// median-bound value (±5cm) used by the "DS" sampling strategy (Algorithm 1)
// in the antenna-delay-calibration paper this was adapted from. Rejects
// multipath-spike outliers (e.g. a stray 3.5m reading among a run of ~2.7m
// ones) instead of a plain moving average silently absorbing them.
#define OUTLIER_THRESHOLD_M 0.05

void newRange()
{
    float r = DW1000Ranging.getDistantDevice()->getRange();

    rangeBuffer[rangeIndex] = r;
    rangeIndex = (rangeIndex + 1) % AVG_WINDOW;
    if (rangeCount < AVG_WINDOW) rangeCount++;

    // Median filter (paper's Algorithm 1 "DS", adapted to run over a
    // continuously-updating window instead of one-shot batches): sort a
    // copy of the current window, find its median, then average only the
    // samples within OUTLIER_THRESHOLD_M of that median. A multipath spike
    // gets excluded instead of dragging the average toward it.
    float sorted[AVG_WINDOW];
    for (uint8_t i = 0; i < rangeCount; i++) sorted[i] = rangeBuffer[i];
    for (uint8_t i = 1; i < rangeCount; i++)
    {
        float key = sorted[i];
        int8_t j = i - 1;
        while (j >= 0 && sorted[j] > key)
        {
            sorted[j + 1] = sorted[j];
            j--;
        }
        sorted[j + 1] = key;
    }
    float median = sorted[rangeCount / 2];

    float filteredSum = 0;
    uint8_t filteredCount = 0;
    for (uint8_t i = 0; i < rangeCount; i++)
    {
        if (fabs(rangeBuffer[i] - median) <= OUTLIER_THRESHOLD_M)
        {
            filteredSum += rangeBuffer[i];
            filteredCount++;
        }
    }
    float avg = filteredSum / filteredCount;

    Serial.print("ANTENNA_DELAY=");
    Serial.print(ANTENNA_DELAY);
    Serial.print("\tfrom: ");
    Serial.print(DW1000Ranging.getDistantDevice()->getShortAddress(), HEX);
    Serial.print("\traw: ");
    Serial.print(r, 4);
    Serial.print(" m\tmedian: ");
    Serial.print(median, 4);
    Serial.print(" m\tfiltered avg(");
    Serial.print(filteredCount);
    Serial.print("/");
    Serial.print(rangeCount);
    Serial.print(" kept): ");
    Serial.print(avg, 4);
    Serial.print(" m\tRX power: ");
    Serial.print(DW1000Ranging.getDistantDevice()->getRXPower());
    Serial.println(" dBm");
}

void newBlink(DW1000Device *device)
{
    Serial.print("blink; 1 device added ! -> ");
    Serial.print(" short:");
    Serial.println(device->getShortAddress(), HEX);
}

void inactiveDevice(DW1000Device *device)
{
    Serial.print("delete inactive device: ");
    Serial.println(device->getShortAddress(), HEX);
}
