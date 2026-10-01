// TrafficGate 통과 토큰 검증 (Java 11+, Jackson 사용 예시)
//
//   Map<String, Object> claims = TrafficGateToken.verify(token, secret, "event"); // 실패 시 null
//
// Spring 인터셉터 예시:
//   String token = request.getHeader("X-TrafficGate-Token");
//   if (TrafficGateToken.verify(token, secret, "event") == null) { response.sendError(429); return false; }
import com.fasterxml.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;

public final class TrafficGateToken {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private TrafficGateToken() {}

    @SuppressWarnings("unchecked")
    public static Map<String, Object> verify(String token, String secret, String segment) {
        if (token == null) return null;
        String[] p = token.split("\\.");
        if (p.length != 3 || !"v1".equals(p[0])) return null;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] expected = mac.doFinal((p[0] + "." + p[1]).getBytes(StandardCharsets.UTF_8));
            byte[] actual = Base64.getUrlDecoder().decode(p[2]);
            if (!MessageDigest.isEqual(expected, actual)) return null;
            Map<String, Object> claims = MAPPER.readValue(Base64.getUrlDecoder().decode(p[1]), Map.class);
            long exp = ((Number) claims.get("exp")).longValue();
            if (Instant.now().getEpochSecond() >= exp) return null;
            if (segment != null && !segment.equals(claims.get("s"))) return null;
            return claims;
        } catch (Exception e) {
            return null;
        }
    }
}
