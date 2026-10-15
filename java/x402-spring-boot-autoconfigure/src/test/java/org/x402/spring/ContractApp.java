package org.x402.spring;

import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.ImportSelector;
import org.springframework.core.type.AnnotationMetadata;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.x402.spring.annotation.X402Payment;

/**
 * The stack-neutral part of the starter contract app: annotated controllers that run unchanged on
 * WebMvc and WebFlux, plus the scheme/hook recorder. An {@link ImportSelector}, so its nested
 * classes are imported explicitly (a configuration class would register every nested
 * {@code @RestController}, including {@link UnknownOfferController}).
 */
public class ContractApp implements ImportSelector {

  @Override
  public String[] selectImports(AnnotationMetadata importingClassMetadata) {
    return new String[] {Beans.class.getName(), ContractController.class.getName(),
        ClassLevelController.class.getName()};
  }

  /** The test scheme registration and hook recorder. */
  @Configuration(proxyBeanMethods = false)
  public static class Beans {

    /**
     * The test scheme registration and hook recorder.
     *
     * @return the recorder
     */
    @Bean
    public HookRecorder hookRecorder() {
      return new HookRecorder();
    }
  }

  /** Method-level offers. */
  @RestController
  public static class ContractController {

    @X402Payment("weather")
    @GetMapping("/weather")
    Map<String, String> weather() {
      return Map.of("forecast", "sunny");
    }

    @X402Payment("weather")
    @GetMapping("/fail/{status}")
    ResponseEntity<String> fail(@PathVariable("status") int status) {
      return ResponseEntity.status(status).body("failed");
    }

    @X402Payment("weather")
    @GetMapping("/throw")
    String boom() {
      throw new IllegalStateException("handler exploded");
    }

    @X402Payment("weather")
    @GetMapping("/items/{id}")
    String item(@PathVariable("id") String id) {
      return "item " + id;
    }

    @GetMapping("/items/free")
    String freeItem() {
      return "free";
    }

    @X402Payment("weather")
    @PostMapping(path = "/consumes", consumes = "application/json")
    String consumes(@RequestBody String body) {
      return "consumed " + body.length();
    }

    @X402Payment("weather")
    @GetMapping("/no-content")
    ResponseEntity<Void> noContent() {
      return ResponseEntity.noContent().build();
    }

    @X402Payment("prepaid")
    @GetMapping("/prepaid/fail")
    ResponseEntity<String> prepaidFail() {
      return ResponseEntity.status(500).body("prepaid failed");
    }

    @X402Payment("weather")
    @CrossOrigin(origins = "*")
    @GetMapping("/cors")
    String cors() {
      return "cors";
    }

    @X402Payment("weather")
    @GetMapping("/overlap")
    String overlap() {
      return "overlap";
    }

    @X402Payment("weather")
    @GetMapping("/secret-redirect")
    ResponseEntity<Void> secretRedirect() {
      return ResponseEntity.status(302)
          .header("Location", "https://cdn.example/presigned?sig=secret")
          .header("X-Download-Token", "secret-token")
          .header("Set-Cookie", "session=secret")
          .build();
    }

    @GetMapping("/report/{name}")
    String report(@PathVariable("name") String name) {
      return "report " + name;
    }

    @GetMapping("/files/{name}")
    String file(@PathVariable("name") String name) {
      return "file " + name;
    }
  }

  /** A class-level offer, overridden on one method. */
  @RestController
  @X402Payment("weather")
  public static class ClassLevelController {

    @GetMapping("/class/inherits")
    String inherits() {
      return "inherits";
    }

    @X402Payment("premium")
    @GetMapping("/class/overrides")
    String overrides() {
      return "overrides";
    }
  }

  /** Only loaded by the unknown-offer variant. */
  @RestController
  public static class UnknownOfferController {

    @X402Payment("nope")
    @GetMapping("/nope")
    String nope() {
      return "nope";
    }
  }
}
