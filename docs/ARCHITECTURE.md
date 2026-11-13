# Thiết kế hệ thống FireRoute

## Topology prototype

```mermaid
graph TD
  G1 --- A
  A --- C
  B --- C
  B --- D
  C --- E
  D --- E
  D --- F
  F --- G2
```

Các cạnh có trọng số: `A-C=2`, `B-C=2`, `B-D=2`, `C-E=2`, `D-E=2`, `D-F=2`, `A-G1=1`, `F-G2=1`. G1 chỉ nối với A và G2 chỉ nối với F; không có cạnh vòng dự phòng.

## Luồng xử lý

1. ESP32 đọc sáu MQ-2 qua CD74HC4067 mỗi 1 giây và sáu DHT11 mỗi 2 giây.
2. Một zone chuyển sang cháy sau ba mẫu nguy hiểm liên tiếp. Nó chỉ trở lại an toàn sau năm mẫu dưới ngưỡng an toàn liên tiếp.
3. ESP32 chạy Dijkstra riêng cho cả sáu điểm A–F. Zone cháy bị cấm làm điểm trung gian, nhưng khi chính nó là điểm bắt đầu, hệ thống vẫn tính hướng đi ra cho người đang ở trong đó.
4. Mỗi LED xanh biểu diễn một chiều qua cửa: sáng nếu chiều đó là next-hop của ít nhất một tuyến an toàn, tắt nếu không được đi. 14 LED (2 LED mỗi cửa trong, 1 LED phía trong mỗi cửa thoát) được quét bằng hai CD74HC4067 trên một task riêng ở core 0.
5. ESP32 ghi `/current` lên Firebase mỗi 15 giây và ghi ngay khi trạng thái thay đổi. Mỗi lần zone bắt đầu/kết thúc cháy tạo hoặc đóng một mục `/fireHistory`.
6. Mất Wi-Fi không ảnh hưởng việc đọc sensor, tính tuyến hay LED.

## Ngưỡng mặc định

- Báo cháy: nhiệt độ ≥ 55 °C hoặc MQ-2 ADC ≥ 2300.
- Hết báo cháy: nhiệt độ < 48 °C và MQ-2 ADC < 2200.
- Đây là ngưỡng demo, không phải ngưỡng an toàn được chứng nhận. Phải ghi lại ADC nền và ADC khi tạo khói thử để hiệu chuẩn từng MQ-2.

## Chế độ demo qua Serial Monitor

```text
FIRE B   mô phỏng cháy ở B
FIRE D   thêm cháy ở D
CLEAR    xóa toàn bộ cháy mô phỏng
AUTO     quay lại sử dụng cảm biến thật
```
