# Sơ đồ đấu dây prototype

## ESP32 và DHT11

| Zone | DATA DHT11 |
|---|---:|
| A | GPIO13 |
| B | GPIO14 |
| C | GPIO25 |
| D | GPIO26 |
| E | GPIO27 |
| F | GPIO32 |

- VCC DHT11 → 3V3; GND → GND.
- Nếu dùng cảm biến DHT11 rời thay vì module, mắc điện trở kéo lên 10 kΩ giữa DATA và 3V3 cho mỗi cảm biến.

## MQ-2 qua CD74HC4067

| CD74HC4067 | ESP32 |
|---|---:|
| S0 | GPIO16 |
| S1 | GPIO17 |
| S2 | GPIO18 |
| S3 | GPIO19 |
| SIG | GPIO34 (ADC1) |
| EN | GND |
| GND | GND chung |

- VCC của CD74HC4067 → 3V3 để các chân chọn mức 3.3 V của ESP32 hoạt động đúng.
- AO của MQ-2 A–F → C0–C5 của multiplexer.
- MQ-2 thường xuất analog tối đa gần 5 V, trong khi cả CD74HC4067 đang cấp 3.3 V và ESP32 chỉ chịu khoảng 3.3 V. Mỗi đường AO cần cầu chia áp, ví dụ 10 kΩ phía MQ-2 và 20 kΩ xuống GND, đặt trước chân C0–C5.
- MQ-2 dùng nguồn 5 V và cần làm nóng. Firmware bỏ cảnh báo khói trong 20 giây đầu; khi sử dụng thật nên warm-up lâu hơn và hiệu chuẩn ngưỡng tại môi trường lắp đặt.

## LED chỉ dẫn WS2812B

- DIN → GPIO23 qua điện trở 330–470 Ω.
- Nguồn LED → nguồn 5 V riêng; đặt tụ khoảng 1000 µF giữa 5 V/GND gần dải LED.
- Bắt buộc nối chung GND nguồn LED và ESP32.
- Khuyến nghị dùng IC chuyển mức 74AHCT125/74HCT14 từ tín hiệu 3.3 V lên 5 V.
- Firmware dùng 20 pixel: hai hướng cho mỗi cạnh theo thứ tự trong bảng dưới.

| Pixel | Hướng | Pixel | Hướng |
|---:|---|---:|---|
| 0 | A → C | 1 | C → A |
| 2 | B → C | 3 | C → B |
| 4 | C → D | 5 | D → C |
| 6 | D → E | 7 | E → D |
| 8 | D → F | 9 | F → D |
| 10 | C → G1 | 11 | tắt |
| 12 | F → G2 | 13 | tắt |
| 14 | A → E | 15 | E → A |
| 16 | B → F | 17 | F → B |
| 18 | E → G1 | 19 | tắt |

LED xanh nghĩa là được đi theo chiều đó; đỏ nghĩa là không đi; chiều từ cửa thoát quay vào trong được tắt.

> BOM ban đầu ghi LED diode rời nhưng kiến trúc ghi WS2812B. Thiết kế này chọn WS2812B vì chỉ cần một GPIO và thể hiện riêng từng chiều. Nếu giữ LED diode rời, cần bổ sung thanh ghi dịch/driver; không nên kéo toàn bộ LED trực tiếp từ GPIO ESP32.
