/*

For ESP32 UWB or ESP32 UWB Pro
Anchor board #2 — short address 1783 (see MAPPING.md)

*/

#include <SPI.h>
#include "DW1000Ranging.h"

#define ANCHOR_ADD "83:17:5B:D5:A9:9A:E2:9C"

#define SPI_SCK 18
#define SPI_MISO 19
#define SPI_MOSI 23

// Calibrated per-anchor value -- see CALIBRATION.md. Each anchor gets its
// OWN calibrated value; do not copy this from another anchor.
#define ANTENNA_DELAY 16573 // TODO: replace with this anchor's calibrated value from CALIBRATION.md

// connection pins
const uint8_t PIN_RST = 27; // reset pin
const uint8_t PIN_IRQ = 34; // irq pin
const uint8_t PIN_SS = 21;   // spi select pin

void setup()
{
    Serial.begin(115200);
    delay(1000);
    //init the configuration
    SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);
    DW1000Ranging.initCommunication(PIN_RST, PIN_SS, PIN_IRQ); //Reset, CS, IRQ pin

    // Must be set after initCommunication() and before startAsAnchor() --
    // see CALIBRATION.md for why.
    DW1000.setAntennaDelay(ANTENNA_DELAY);

    //define the sketch as anchor. It will be great to dynamically change the type of module
    DW1000Ranging.attachNewRange(newRange);
    DW1000Ranging.attachBlinkDevice(newBlink);
    DW1000Ranging.attachInactiveDevice(inactiveDevice);
    //Enable the filter to smooth the distance
    //DW1000Ranging.useRangeFilter(true);

    //we start the module as an anchor
    DW1000Ranging.startAsAnchor(ANCHOR_ADD, DW1000.MODE_LONGDATA_RANGE_LOWPOWER, false);
    Serial.println("[anchor_1783] short address = 1783 (position key: 1783 in anchors.json)");
}

void loop()
{
    DW1000Ranging.loop();
}

void newRange()
{
    Serial.print("from: ");
    Serial.print(DW1000Ranging.getDistantDevice()->getShortAddress(), HEX);
    Serial.print("\t Range: ");
    Serial.print(DW1000Ranging.getDistantDevice()->getRange());
    Serial.print(" m");
    Serial.print("\t RX power: ");
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
