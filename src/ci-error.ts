// Intentional failures to verify the CI gates. Delete this file to clean up.

// 1) Type error -> fails GitHub Actions `typecheck` and `build`.
export const ciTypeError: number = 'this is not a number';

// 2) Insecure RNG (Sonar rule S2245) -> drops the New Code security
//    rating to C and fails the SonarCloud quality gate. Framing it as a
//    token generator makes the security-sensitivity explicit to Sonar.
export function weakToken(): string {
  return Math.random().toString(36).slice(2);
}
