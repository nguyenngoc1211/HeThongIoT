# BOM chốt cho prototype 6 zone

| Hạng mục | Số lượng | Ghi chú |
|---|---:|---|
| ESP32 DevKit V1 | 1 | Bộ điều khiển trung tâm |
| MQ-2 module | 6 | Khói/gas, cấp 5 V |
| DHT11 module | 6 | Nhiệt độ, cấp 3.3 V |
| CD74HC4067 | 1 | Ghép 6 ngõ analog MQ-2 |
| WS2812B | 20 pixel | Hai hướng cho mỗi cạnh/cửa trong graph 10 cạnh |
| Nguồn 5 V 10 A | 1 | Dùng được; 5 V 3 A cũng đủ cho prototype này |
| Điện trở 10 kΩ | 12 | Sáu cầu chia áp MQ-2 |
| Điện trở 20 kΩ | 6 | Nửa dưới cầu chia áp MQ-2; có thể ghép 2 × 10 kΩ nối tiếp |
| Điện trở 330–470 Ω | 1 | Nối tiếp DATA WS2812B |
| Tụ điện 1000 µF, ≥6.3 V | 1 | Ổn định nguồn LED |
| 74AHCT125 hoặc 74HCT14 | 1 | Khuyến nghị chuyển mức DATA LED 3.3 → 5 V |
| Breadboard, dây nối, formex | 1 bộ | Lắp prototype |

Nguồn 5 V phải cấp trực tiếp cho MQ-2 và WS2812B. ESP32 có thể cấp qua chân VIN/5V từ cùng nguồn nếu nguồn ổn định. Tất cả thiết bị phải dùng chung GND.

Không sử dụng 40 LED diode rời trong bản chốt này. Nếu nhóm đã mua chúng, có thể dùng làm đèn trang trí/trạng thái zone, nhưng không nối số lượng lớn trực tiếp vào ESP32.
