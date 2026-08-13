import java.lang.reflect.Array;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Generic grading harness for Java write/fix exercises. Reads tests.json
 * ({"functionName": ..., "tests": [{"args": [...], "expected": ...}]}) from the
 * working directory, invokes the named method on class Solution via reflection,
 * canonicalizes both sides to sorted-key JSON, and prints one line:
 *   ATROPHY_RESULT {"passed":N,"total":M,"failures":[...]}
 *
 * Number model (must match the Node harness's JSON.stringify semantics):
 *  - parse: integer literals that fit a long -> Long, everything else -> Double
 *  - serialize: Long as integer; finite integral Double with |v| <= 2^53 as integer;
 *    NaN/Infinity -> null
 *
 * Supported parameter/return types (anything else is a NAMED error, never a crash):
 *  int, long, double, boolean, char, String, Integer, Long, Double, Boolean, Character,
 *  int[], long[], double[], boolean[], String[], List<T> (T from generics), Map<String,T>, Object.
 */
public final class Harness {
    private static final int MAX_DEPTH = 64;

    public static void main(String[] args) throws Exception {
        Map<String, Object> spec = asMap(Json.parse(Files.readString(Path.of("tests.json"))));
        String functionName = (String) spec.get("functionName");
        List<Object> tests = asList(spec.get("tests"));
        int total = tests.size();

        Class<?> solutionClass;
        try {
            solutionClass = Class.forName("Solution");
        } catch (Throwable t) {
            emitLoadError(total, "could not load class Solution - keep `public class Solution` in the default package (no `package` line). " + t);
            return;
        }

        List<Map<String, Object>> failures = new ArrayList<>();
        int passed = 0;
        for (int i = 0; i < total; i++) {
            Map<String, Object> test = asMap(tests.get(i));
            List<Object> testArgs = asList(test.get("args"));
            Object expected = test.get("expected");
            Map<String, Object> failure = new TreeMap<>();
            failure.put("index", (long) i);
            failure.put("args", testArgs);
            failure.put("expected", expected);
            try {
                Method method = findMethod(solutionClass, functionName, testArgs.size());
                Object target = Modifier.isStatic(method.getModifiers()) ? null : solutionClass.getDeclaredConstructor().newInstance();
                Object[] coerced = new Object[testArgs.size()];
                Type[] generics = method.getGenericParameterTypes();
                for (int p = 0; p < coerced.length; p++) {
                    coerced[p] = coerce(testArgs.get(p), generics[p]);
                }
                Object actual = method.invoke(target, coerced);
                Object canonActual = canon(actual, 0);
                Object canonExpected = canon(expected, 0);
                if (Json.write(canonActual).equals(Json.write(canonExpected))) {
                    passed++;
                } else {
                    failure.put("actual", canonActual);
                    failures.add(failure);
                }
            } catch (InvocationTargetException e) {
                failure.put("error", describeThrowable(e.getCause() == null ? e : e.getCause()));
                failures.add(failure);
            } catch (HarnessProblem e) {
                failure.put("error", e.getMessage());
                failures.add(failure);
            } catch (Throwable t) {
                failure.put("error", describeThrowable(t));
                failures.add(failure);
            }
        }

        Map<String, Object> result = new TreeMap<>();
        result.put("passed", (long) passed);
        result.put("total", (long) total);
        result.put("failures", failures);
        System.out.println("ATROPHY_RESULT " + Json.write(result));
    }

    /** A named, user-readable grading problem (unsupported type, bad arity, ...). */
    private static final class HarnessProblem extends RuntimeException {
        private static final long serialVersionUID = 1L;

        HarnessProblem(String message) { super(message); }
    }

    private static void emitLoadError(int total, String message) {
        Map<String, Object> failure = new TreeMap<>();
        failure.put("index", -1L);
        failure.put("args", new ArrayList<>());
        failure.put("expected", null);
        failure.put("error", message);
        Map<String, Object> result = new TreeMap<>();
        result.put("passed", 0L);
        result.put("total", (long) total);
        result.put("failures", List.of(failure));
        System.out.println("ATROPHY_RESULT " + Json.write(result));
    }

    /**
     * Starter signatures are package-private, so getMethods() (public only) would
     * miss every one of them. Union in the declared methods up the superclass chain
     * and dedupe by generic signature. Harness and Solution share the unnamed
     * package, so package-private access needs no setAccessible.
     */
    private static Method findMethod(Class<?> cls, String name, int arity) {
        Map<String, Method> bySignature = new LinkedHashMap<>();
        for (Method m : cls.getMethods()) {
            if (m.getName().equals(name)) bySignature.putIfAbsent(m.toGenericString(), m);
        }
        for (Class<?> c = cls; c != null; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (m.getName().equals(name)) bySignature.putIfAbsent(m.toGenericString(), m);
            }
        }
        List<Method> nameMatches = new ArrayList<>(bySignature.values());
        if (nameMatches.isEmpty()) {
            throw new HarnessProblem("no method named `" + name + "` on Solution - keep the starter signature");
        }
        List<Method> arityMatches = new ArrayList<>();
        for (Method m : nameMatches) {
            if (m.getParameterCount() == arity) arityMatches.add(m);
        }
        if (arityMatches.isEmpty()) {
            throw new HarnessProblem("`" + name + "` exists but no overload takes " + arity + " argument(s)");
        }
        if (arityMatches.size() > 1) {
            throw new HarnessProblem("`" + name + "` has " + arityMatches.size() + " overloads with " + arity + " parameter(s) - overloads are not supported");
        }
        Method method = arityMatches.get(0);
        if (Modifier.isPrivate(method.getModifiers())) {
            throw new HarnessProblem("`" + name + "` is private - make it package-private or public");
        }
        return method;
    }

    // ---------- coercion: parsed JSON -> declared parameter type ----------

    private static Object coerce(Object v, Type type) {
        Class<?> raw = rawClass(type);
        if (raw == Object.class) return v;
        if (v == null) {
            if (raw.isPrimitive()) throw new HarnessProblem("test passes null into primitive " + raw.getName());
            return null;
        }
        if (raw == int.class || raw == Integer.class) return requireInt(v);
        if (raw == long.class || raw == Long.class) return requireIntegral(v, "long");
        if (raw == double.class || raw == Double.class) {
            if (v instanceof Number n) return n.doubleValue();
            throw new HarnessProblem("cannot coerce " + typeName(v) + " to double");
        }
        if (raw == boolean.class || raw == Boolean.class) {
            if (v instanceof Boolean b) return b;
            throw new HarnessProblem("cannot coerce " + typeName(v) + " to boolean");
        }
        if (raw == char.class || raw == Character.class) {
            if (v instanceof String s && s.length() == 1) return s.charAt(0);
            throw new HarnessProblem("char parameters take a 1-character string, got " + typeName(v));
        }
        if (raw == String.class) {
            if (v instanceof String s) return s;
            throw new HarnessProblem("cannot coerce " + typeName(v) + " to String");
        }
        if (raw.isArray()) {
            if (!(v instanceof List<?> list)) throw new HarnessProblem("cannot coerce " + typeName(v) + " to " + raw.getSimpleName());
            Class<?> component = raw.getComponentType();
            Object arr = Array.newInstance(component, list.size());
            for (int i = 0; i < list.size(); i++) {
                Array.set(arr, i, coerce(list.get(i), component));
            }
            return arr;
        }
        if (List.class.isAssignableFrom(raw)) {
            if (!(v instanceof List<?> list)) throw new HarnessProblem("cannot coerce " + typeName(v) + " to List");
            Type elem = typeArg(type, 0);
            List<Object> out = new ArrayList<>(list.size());
            for (Object item : list) out.add(elem == null ? item : coerce(item, elem));
            return out;
        }
        if (Map.class.isAssignableFrom(raw)) {
            if (!(v instanceof Map<?, ?> map)) throw new HarnessProblem("cannot coerce " + typeName(v) + " to Map");
            Type keyType = typeArg(type, 0);
            if (keyType != null && keyType != String.class) {
                // JSON object keys are strings; handing them to a Map<Integer,..> would
                // only surface as a ClassCastException blamed on the user's own line.
                throw new HarnessProblem("Map parameters must use String keys");
            }
            Type valType = typeArg(type, 1);
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : map.entrySet()) {
                out.put(String.valueOf(e.getKey()), valType == null ? e.getValue() : coerce(e.getValue(), valType));
            }
            return out;
        }
        throw new HarnessProblem("unsupported parameter type " + raw.getName() + " (supported: primitives, String, arrays, List, Map, Object)");
    }

    /** 2^63: the magnitude at which a (long) cast stops round-tripping and starts saturating. */
    private static final double LONG_LIMIT = 9.223372036854775808E18;

    private static long requireIntegral(Object v, String target) {
        if (v instanceof Long l) return l;
        if (v instanceof Double d && d == Math.rint(d) && !d.isInfinite()) {
            if (d < -LONG_LIMIT || d >= LONG_LIMIT) {
                throw new HarnessProblem("test passes " + d + " which does not fit " + target);
            }
            return (long) (double) d;
        }
        throw new HarnessProblem("cannot coerce " + (v instanceof Number ? String.valueOf(v) : typeName(v)) + " to " + target);
    }

    /** Narrowing to int must never wrap silently - a truncated arg grades the wrong question. */
    private static int requireInt(Object v) {
        long l = requireIntegral(v, "int");
        if (l < Integer.MIN_VALUE || l > Integer.MAX_VALUE) {
            throw new HarnessProblem("test passes " + l + " which does not fit int");
        }
        return (int) l;
    }

    private static Class<?> rawClass(Type type) {
        if (type instanceof Class<?> c) return c;
        if (type instanceof ParameterizedType p && p.getRawType() instanceof Class<?> c) return c;
        throw new HarnessProblem("unsupported parameter type " + type);
    }

    private static Type typeArg(Type type, int index) {
        if (type instanceof ParameterizedType p && p.getActualTypeArguments().length > index) {
            return p.getActualTypeArguments()[index];
        }
        return null;
    }

    // ---------- canonicalization: return value -> JSON-ready structure ----------

    private static Object canon(Object v, int depth) {
        if (depth > MAX_DEPTH) throw new HarnessProblem("return value nests deeper than " + MAX_DEPTH + " levels (cycle?)");
        if (v == null || v instanceof Boolean || v instanceof String) return v;
        if (v instanceof Character c) return String.valueOf(c);
        if (v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte) {
            return ((Number) v).longValue();
        }
        if (v instanceof Double || v instanceof Float) return ((Number) v).doubleValue();
        if (v.getClass().isArray()) {
            int n = Array.getLength(v);
            List<Object> out = new ArrayList<>(n);
            for (int i = 0; i < n; i++) out.add(canon(Array.get(v, i), depth + 1));
            return out;
        }
        if (v instanceof Collection<?> col) {
            List<Object> out = new ArrayList<>(col.size());
            for (Object item : col) out.add(canon(item, depth + 1));
            return out;
        }
        if (v instanceof Map<?, ?> map) {
            Map<String, Object> out = new TreeMap<>();
            for (Map.Entry<?, ?> e : map.entrySet()) out.put(String.valueOf(e.getKey()), canon(e.getValue(), depth + 1));
            return out;
        }
        throw new HarnessProblem("unsupported return type " + v.getClass().getName() + " (return primitives, String, arrays, List, or Map)");
    }

    private static String typeName(Object v) {
        return v == null ? "null" : v.getClass().getSimpleName();
    }

    /** The top user frames only: the reflective call plumbing under them is our noise, not theirs. */
    private static String describeThrowable(Throwable t) {
        StringBuilder sb = new StringBuilder(t.toString());
        int shown = 0;
        for (StackTraceElement frame : t.getStackTrace()) {
            String cls = frame.getClassName();
            if (cls.startsWith("jdk.internal.reflect") || cls.startsWith("java.lang.reflect.")) continue;
            if (cls.equals("Harness") || cls.startsWith("Harness$")) break;
            sb.append("\n  at ").append(frame);
            if (++shown == 2) break;
        }
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object v) {
        return (Map<String, Object>) v;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object v) {
        return (List<Object>) v;
    }

    // ---------- minimal JSON: parse to Map/List/String/Long/Double/Boolean/null ----------

    static final class Json {
        private final String src;
        private int pos;

        private Json(String src) { this.src = src; }

        static Object parse(String src) {
            Json j = new Json(src);
            Object v = j.value();
            j.ws();
            if (j.pos != src.length()) throw new IllegalArgumentException("trailing JSON at " + j.pos);
            return v;
        }

        private Object value() {
            ws();
            char c = peek();
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (c == 't') { expect("true"); return Boolean.TRUE; }
            if (c == 'f') { expect("false"); return Boolean.FALSE; }
            if (c == 'n') { expect("null"); return null; }
            return number();
        }

        private Map<String, Object> object() {
            Map<String, Object> out = new LinkedHashMap<>();
            pos++; // {
            ws();
            if (peek() == '}') { pos++; return out; }
            while (true) {
                ws();
                String key = string();
                ws();
                if (src.charAt(pos++) != ':') throw new IllegalArgumentException("expected : at " + (pos - 1));
                out.put(key, value());
                ws();
                char c = src.charAt(pos++);
                if (c == '}') return out;
                if (c != ',') throw new IllegalArgumentException("expected , or } at " + (pos - 1));
            }
        }

        private List<Object> array() {
            List<Object> out = new ArrayList<>();
            pos++; // [
            ws();
            if (peek() == ']') { pos++; return out; }
            while (true) {
                out.add(value());
                ws();
                char c = src.charAt(pos++);
                if (c == ']') return out;
                if (c != ',') throw new IllegalArgumentException("expected , or ] at " + (pos - 1));
            }
        }

        private String string() {
            if (src.charAt(pos++) != '"') throw new IllegalArgumentException("expected string at " + (pos - 1));
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = src.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    char e = src.charAt(pos++);
                    switch (e) {
                        case '"' -> sb.append('"');
                        case '\\' -> sb.append('\\');
                        case '/' -> sb.append('/');
                        case 'b' -> sb.append('\b');
                        case 'f' -> sb.append('\f');
                        case 'n' -> sb.append('\n');
                        case 'r' -> sb.append('\r');
                        case 't' -> sb.append('\t');
                        case 'u' -> { sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16)); pos += 4; }
                        default -> throw new IllegalArgumentException("bad escape \\" + e);
                    }
                } else {
                    sb.append(c);
                }
            }
        }

        private Object number() {
            int start = pos;
            if (peek() == '-') pos++;
            boolean fractional = false;
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c >= '0' && c <= '9') pos++;
                else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { fractional = fractional || c == '.' || c == 'e' || c == 'E'; pos++; }
                else break;
            }
            String text = src.substring(start, pos);
            if (!fractional) {
                try {
                    return Long.parseLong(text);
                } catch (NumberFormatException ignored) {
                    // falls through to Double for out-of-range integers
                }
            }
            return Double.parseDouble(text);
        }

        private void ws() {
            while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) pos++;
        }

        private char peek() {
            if (pos >= src.length()) throw new IllegalArgumentException("unexpected end of JSON");
            return src.charAt(pos);
        }

        private void expect(String word) {
            if (!src.startsWith(word, pos)) throw new IllegalArgumentException("bad literal at " + pos);
            pos += word.length();
        }

        static String write(Object v) {
            StringBuilder sb = new StringBuilder();
            writeValue(v, sb);
            return sb.toString();
        }

        private static void writeValue(Object v, StringBuilder sb) {
            if (v == null) { sb.append("null"); return; }
            if (v instanceof String s) { writeString(s, sb); return; }
            if (v instanceof Boolean b) { sb.append(b); return; }
            if (v instanceof Long l) { sb.append((long) l); return; }
            if (v instanceof Double d) { writeDouble(d, sb); return; }
            if (v instanceof List<?> list) {
                sb.append('[');
                for (int i = 0; i < list.size(); i++) {
                    if (i > 0) sb.append(',');
                    writeValue(list.get(i), sb);
                }
                sb.append(']');
                return;
            }
            if (v instanceof Map<?, ?> map) {
                TreeMap<String, Object> sorted = new TreeMap<>();
                for (Map.Entry<?, ?> e : map.entrySet()) sorted.put(String.valueOf(e.getKey()), e.getValue());
                sb.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : sorted.entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    writeString(e.getKey(), sb);
                    sb.append(':');
                    writeValue(e.getValue(), sb);
                }
                sb.append('}');
                return;
            }
            throw new IllegalArgumentException("cannot serialize " + v.getClass().getName());
        }

        /** Integral finite doubles up to 2^53 print as integers - JSON.stringify parity. */
        private static void writeDouble(double d, StringBuilder sb) {
            if (Double.isNaN(d) || Double.isInfinite(d)) { sb.append("null"); return; }
            if (d == Math.rint(d) && Math.abs(d) <= 9007199254740992.0) { sb.append((long) d); return; }
            sb.append(d);
        }

        private static void writeString(String s, StringBuilder sb) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    default -> {
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                    }
                }
            }
            sb.append('"');
        }
    }
}
