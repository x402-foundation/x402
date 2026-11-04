package org.x402.http;

import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Raised by {@link HttpResourceServer#initialize()} when a route cannot be served, e.g. because no scheme
 * server is registered for one of its payment options or no facilitator supports it. Every problem is reported,
 * not only the first.
 */
public final class RouteConfigurationException extends IllegalStateException {

    /** No scheme server is registered for the option's network and scheme. */
    public static final String MISSING_SCHEME = "missing_scheme";

    /** The option asks for a payment flow other than {@code authorization}. */
    public static final String UNSUPPORTED_PAYMENT_FLOW = "unsupported_payment_flow";

    /** No facilitator advertised support for the option's network and scheme. */
    public static final String MISSING_FACILITATOR = "missing_facilitator";

    /** The scheme server cannot build requirements for the option, e.g. it rejects the price or {@code extra}. */
    public static final String INVALID_PAYMENT_OPTION = "invalid_payment_option";

    private static final long serialVersionUID = 1L;

    private final transient List<Problem> problems;

    /**
     * Creates an exception.
     *
     * @param problems the problems found, at least one
     * @throws IllegalArgumentException if {@code problems} is empty
     */
    public RouteConfigurationException(List<Problem> problems) {
        super(message(problems));
        this.problems = List.copyOf(problems);
    }

    /**
     * Returns the problems found, in route order.
     *
     * @return the problems; empty after Java deserialization, which does not preserve them
     */
    public List<Problem> problems() {
        return problems == null ? List.of() : problems;
    }

    private static String message(List<Problem> problems) {
        Objects.requireNonNull(problems, "problems");
        if (problems.isEmpty()) {
            throw new IllegalArgumentException("problems must not be empty");
        }
        return problems.stream()
                .map(Problem::message)
                .collect(Collectors.joining("\n  - ", "x402 route configuration errors:\n  - ", ""));
    }

    /**
     * One route configuration problem.
     *
     * @param route the route pattern, e.g. {@code "GET /weather"}
     * @param scheme the payment option's scheme
     * @param network the payment option's network
     * @param reason {@link #MISSING_SCHEME}, {@link #UNSUPPORTED_PAYMENT_FLOW}, {@link #MISSING_FACILITATOR} or
     *     {@link #INVALID_PAYMENT_OPTION}
     * @param message a human-readable description
     */
    public record Problem(String route, String scheme, String network, String reason, String message) {

        /**
         * Creates a problem.
         */
        public Problem {
            Objects.requireNonNull(route, "route");
            Objects.requireNonNull(scheme, "scheme");
            Objects.requireNonNull(network, "network");
            Objects.requireNonNull(reason, "reason");
            Objects.requireNonNull(message, "message");
        }
    }
}
