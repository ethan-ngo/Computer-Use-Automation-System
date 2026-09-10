import { describe, expect, it } from 'vitest';
import { inertify } from '../src/cli/capture-fixtures.js';

describe('captured fixtures are inert', () => {
  const captured = `
    <html><head>
      <link rel="stylesheet" href="https://parabank.parasoft.com/parabank/style.css">
      <script src="https://cdn.example.com/analytics.js"></script>
      <base href="https://parabank.parasoft.com/parabank/">
    </head><body>
      <img src="https://parabank.parasoft.com/parabank/logo.png" alt="ParaBank">
      <script>trackPageView();</script>
      <form action="login.htm" method="post">
        <td>Username</td><input name="username" type="text">
      </form>
    </body></html>`;

  const inert = inertify(captured);

  it('strips everything that would reach the network during offline replay', () => {
    expect(inert).not.toContain('<script');
    expect(inert).not.toContain('stylesheet');
    expect(inert).not.toContain('<base');
    expect(inert).not.toContain('logo.png');
  });

  it('keeps the structure the locators actually target', () => {
    // The whole value of a fixture is that the same locator chain resolves against it, so
    // the legacy caption cell and the form controls have to survive untouched.
    expect(inert).toContain('<td>Username</td>');
    expect(inert).toContain('name="username"');
    expect(inert).toContain('action="login.htm"');
  });
});
