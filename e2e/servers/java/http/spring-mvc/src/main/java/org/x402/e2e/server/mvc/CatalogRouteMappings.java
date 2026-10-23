package org.x402.e2e.server.mvc;

import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.Map;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.context.EnvironmentAware;
import org.springframework.core.env.Environment;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.x402.e2e.server.E2eServerConfig;

/**
 * Registers a GET handler for every catalog route protected by a YAML {@code path:} offer. The
 * mappings are added as soon as Spring's {@code RequestMappingHandlerMapping} is initialized, so
 * the x402 offer registry sees them at startup.
 */
final class CatalogRouteMappings implements BeanPostProcessor, EnvironmentAware {

  private Environment environment;

  @Override
  public void setEnvironment(Environment environment) {
    this.environment = environment;
  }

  @Override
  public Object postProcessAfterInitialization(Object bean, String beanName) {
    if (bean instanceof RequestMappingHandlerMapping mapping
        && "requestMappingHandlerMapping".equals(beanName)) {
      String paths = environment.getProperty(E2eServerConfig.CATALOG_PATHS_PROPERTY, "");
      Method handle;
      try {
        handle = Handler.class.getDeclaredMethod("handle");
      } catch (NoSuchMethodException e) {
        throw new IllegalStateException(e);
      }
      Handler handler = new Handler();
      Arrays.stream(paths.split(",")).map(String::trim).filter(s -> !s.isEmpty()).forEach(path ->
          mapping.registerMapping(
              RequestMappingInfo.paths(path).methods(RequestMethod.GET)
                  .options(mapping.getBuilderConfiguration()).build(),
              handler, handle));
    }
    return bean;
  }

  /** The handler behind every catalog path: the fixed success body. */
  static final class Handler {

    /**
     * Answers a paid catalog route.
     *
     * @return the success body
     */
    public ResponseEntity<Map<String, Object>> handle() {
      return ResponseEntity.ok(E2eServerConfig.successBody());
    }
  }
}
