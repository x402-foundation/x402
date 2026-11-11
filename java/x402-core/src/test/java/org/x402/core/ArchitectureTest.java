package org.x402.core;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.Test;

/** Core stays framework- and mechanism-free (plan: dependency delta). */
class ArchitectureTest {

  private final JavaClasses core =
      new ClassFileImporter()
          .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
          .importPackages("org.x402.core", "org.x402.http");

  @Test
  void coreDoesNotDependOnSpring() {
    noClasses().should().dependOnClassesThat().resideInAPackage("org.springframework..")
        .check(core);
  }

  @Test
  void coreDoesNotDependOnMechanismsOrExtensions() {
    noClasses().should().dependOnClassesThat()
        .resideInAnyPackage("org.x402.mechanisms..", "org.x402.extensions..", "org.x402.spring..")
        .check(core);
  }
}
