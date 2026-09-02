import java.util.ArrayList;
import java.util.List;

/**
 * Optional helper for exercise-supplied harnesses (testCode). Usage:
 *   Atrophy.plan(4);                       // declare totalChecks up front
 *   Atrophy.watchdog(20_000);              // deadlock insurance: report partial results
 *   Atrophy.check("writers exclusive", ok);
 *   Atrophy.report();                      // prints the ATROPHY_RESULT line (idempotent)
 * A harness may also print the marker line itself; this class is sugar, not magic.
 */
public final class Atrophy {
    private static final List<String> failures = new ArrayList<>();
    private static int planned = 0;
    private static int ran = 0;
    private static int passed = 0;
    private static boolean reported = false;

    private Atrophy() {}

    /** Declare how many checks this harness runs (must equal the exercise's totalChecks). */
    public static synchronized void plan(int totalChecks) {
        planned = totalChecks;
    }

    public static synchronized void check(String name, boolean ok) {
        ran++;
        if (ok) passed++;
        // A null name would reach esc() in report() and NPE there, printing no marker at
        // all - an authoring slip must read as the failed check it is, not as a harness error.
        else failures.add(bounded(name == null ? "(unnamed check)" : name));
    }

    /** A failure name beyond this is elided - see {@link #bounded}. */
    private static final int MAX_NAME_CHARS = 500;

    /**
     * Bound one failure name. This project's own authoring convention
     * (`catch (Throwable t) { Atrophy.check("harness crashed: " + t, false); }`) makes
     * `name` effectively attacker-controlled: it can carry the full message of whatever
     * the submitted solution threw. A single call here can otherwise approach runner.ts's
     * 256KB output cap on its own, which turns a real failure into an unparseable-marker
     * error instead of a score - so it is bounded at the source, once, for every harness
     * that uses the idiom.
     */
    private static String bounded(String name) {
        if (name == null || name.length() <= MAX_NAME_CHARS) return name;
        return name.substring(0, MAX_NAME_CHARS) + "... (" + (name.length() - MAX_NAME_CHARS) + " more chars)";
    }

    /**
     * Print the result marker exactly once. Checks that never ran (deadlock, timeout)
     * are reported as failures so the declared total always matches.
     */
    public static synchronized void report() {
        if (reported) return;
        reported = true;
        int total = Math.max(planned, ran);
        for (int i = ran; i < total; i++) {
            failures.add("check not reached (deadlock or timeout?)");
        }
        StringBuilder sb = new StringBuilder("ATROPHY_RESULT {\"passed\":").append(passed)
                .append(",\"total\":").append(total).append(",\"failures\":[");
        for (int i = 0; i < failures.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append("{\"index\":").append(i).append(",\"error\":\"").append(esc(failures.get(i))).append("\"}");
        }
        sb.append("]}");
        System.out.println(sb);
        System.out.flush();
    }

    /**
     * Start a daemon watchdog: if the harness has not reported after millis, print
     * partial results and halt the JVM (halt, not exit - deadlocked threads must not
     * block shutdown). Keep millis comfortably under the exercise's testTimeoutMs.
     */
    public static void watchdog(long millis) {
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(millis);
            } catch (InterruptedException e) {
                return;
            }
            report();
            Runtime.getRuntime().halt(0);
        }, "atrophy-watchdog");
        t.setDaemon(true);
        t.start();
    }

    private static String esc(String s) {
        StringBuilder sb = new StringBuilder();
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
        return sb.toString();
    }
}
