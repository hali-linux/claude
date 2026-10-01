# 예제

| 경로 | 내용 |
| --- | --- |
| `web/` | JS 에이전트 연동 데모 페이지 (링크 속성, 스크립트 제어, 페이지 진입 대기) |
| `verify/verify.py` | Python 3.9+ 통과 토큰 검증 (표준 라이브러리만) |
| `verify/verify.js` | Node.js 16+ 통과 토큰 검증 (외부 패키지 없음) |
| `verify/TrafficGateToken.java` | Java 11+ 통과 토큰 검증 (Jackson) |

## 데모 실행

```bash
# 1) TrafficGate 실행 (기본 세그먼트 'default')
trafficgate init-config -out ./config.yaml -data-dir ./data
trafficgate serve -config ./config.yaml

# 2) 데모 페이지 제공
cd examples/web && python3 -m http.server 8080
# 브라우저에서 http://localhost:8080 접속
```

대기 화면을 보려면 관리 콘솔(http://127.0.0.1:8801)에서 `default` 세그먼트의 진입 허용 수를 0 으로 바꾸세요.
다시 1 이상으로 올리면 대기자가 순서대로 입장합니다.
