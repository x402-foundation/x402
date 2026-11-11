package org.x402.examples.facilitator;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Who may use the facilitator. {@code /supported} is public. {@code /verify} and {@code /settle}
 * need HTTP Basic as {@code FACILITATOR_USER} (default {@code x402}) with {@code
 * FACILITATOR_PASSWORD}: an open {@code /settle} lets anyone relay transactions through your
 * Blockfrost quota. CSRF is switched off for the facilitator paths only, because resource servers
 * call them without a CSRF token; with Spring Security's defaults those POSTs would get 403.
 */
@Configuration
class SecurityConfig {

  @Bean
  SecurityFilterChain facilitatorSecurity(HttpSecurity http,
      @Value("${x402.facilitator-server.base-path:/x402}") String basePath) throws Exception {
    String base = basePath.endsWith("/") ? basePath.substring(0, basePath.length() - 1)
        : basePath;
    http.authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.GET, base + "/supported").permitAll()
            .requestMatchers(base + "/verify", base + "/settle").authenticated()
            .anyRequest().denyAll())
        .httpBasic(Customizer.withDefaults())
        .csrf(csrf -> csrf.ignoringRequestMatchers(base + "/**"));
    return http.build();
  }

  /**
   * The one user resource servers authenticate as. Fails closed: the facilitator does not start
   * without a password, with a blank one, or with one that is still an unresolved placeholder.
   */
  @Bean
  UserDetailsService facilitatorUser(@Value("${FACILITATOR_USER:x402}") String user,
      @Value("${FACILITATOR_PASSWORD}") String password) {
    if (password.isBlank() || password.contains("${")) {
      throw new IllegalStateException("FACILITATOR_PASSWORD must be set to a non-blank value");
    }
    PasswordEncoder encoder = PasswordEncoderFactories.createDelegatingPasswordEncoder();
    return new InMemoryUserDetailsManager(User.withUsername(user)
        .password(encoder.encode(password)).roles("RESOURCE_SERVER").build());
  }
}
