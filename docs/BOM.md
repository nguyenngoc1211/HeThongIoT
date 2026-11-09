# BOM theo linh kiện thực tế của nhóm

| Hạng mục | Số lượng | Ghi chú |
|---|---:|---|
| ESP32 DevKit 30 chân | 1 | Bộ điều khiển trung tâm, cấp bằng USB máy tính |
| MQ-2 module (4 chân) | 6 | Khói/gas, cấp 5 V, chỉ dùng chân AO |
| DHT11 module | 6 | Nhiệt độ, cấp 3,3 V |
| CD74HC4067 | 3 | #1 đọc MQ-2, #2 và #3 quét LED |
| LED xanh lá 2 chân | 17 (có khoảng 40) | Chỉ hướng đi. Dư LED có thể làm đèn trạng thái |
| Điện trở 10 kΩ | 12 | Sáu cầu chia áp MQ-2 (mỗi cầu 2 điện trở) |
| Sạc dự phòng 5 V | 1 | Cấp 5 V cho 6 MQ-2, nối chung GND với ESP32 |
| Breadboard, dây nối | 1 bộ | Cần nhiều dây: khoảng 60 sợi |

**Không còn dùng:** WS2812B, tụ 1000 µF, điện trở 330–470 Ω, 74AHCT125/74HCT14, điện trở 20 kΩ, vì nhóm không có các linh kiện này.

Nguồn 5 V chỉ cấp cho MQ-2. ESP32 cấp bằng USB máy tính để dashboard đọc Serial. Mọi thiết bị phải dùng chung GND.

Sơ đồ đấu dây chi tiết nằm ở `docs/WIRING.md`.
