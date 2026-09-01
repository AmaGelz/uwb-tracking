#include <Arduino.h>
#include <SPI.h>
#include "DW1000Ranging.h"

void newRange();
void newBlink(DW1000Device *device);
void inactiveDevice(DW1000Device *device);

#include "../../../anchor/anchor_1784/anchor_1784.ino"

