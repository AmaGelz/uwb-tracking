# SUPALAI UWB hardware mapping

| Physical board | UWB address | Firmware | Plan Editor `hardware_address` |
| --- | --- | --- | --- |
| Anchor 1 | `82:17:5B:D5:A9:9A:E2:9C` | `anchor/anchor_1782/anchor_1782.ino` | `1782` |
| Anchor 2 | `83:17:5B:D5:A9:9A:E2:9C` | `anchor/anchor_1783/anchor_1783.ino` | `1783` |
| Anchor 3 | `84:17:5B:D5:A9:9A:E2:9C` | `anchor/anchor_1784/anchor_1784.ino` | `1784` |
| Tag 1 | `7D:00:22:EA:82:60:3B:9C` | `tag/supalai_tag/supalai_tag.ino` | Tag ID `TAG01` |

Coordinates configured for anchors in Plan Editor are metres. The production
tag sends the short address reported by DW1000 (`1782`, `1783`, `1784`) and
the backend maps it through `anchors.hardware_address` before calculating the
tag position.
