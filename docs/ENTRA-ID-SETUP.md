# Microsoft Entra ID setup

Use one tenant and one API app registration. Stage 1 is deliberately not
multi-tenant and does not need a client secret because it is a resource server,
not a confidential client obtaining tokens for itself.

## App registration

1. In Microsoft Entra admin center, create an app registration named
   `e-conomic MCP API` with **Accounts in this organizational directory only**.
2. Record the Directory (tenant) ID as `ENTRA_TENANT_ID` and Application
   (client) ID as `ENTRA_API_CLIENT_ID`.
3. Under **Expose an API**, accept or set the Application ID URI and add delegated
   scope `Mcp.Access`. Admin consent is recommended. Configure
   `ENTRA_REQUIRED_SCOPE=Mcp.Access`. The server checks that short name in the
   token's `scp` claim, while OAuth discovery and authentication challenges
   advertise the Entra-qualified request scope
   `api://<ENTRA_API_CLIENT_ID>/Mcp.Access`.
4. Under **App roles**, create user/group roles with exact values:
   `Economic.Reader` and `Economic.DraftCreator`. Enable both roles.
5. Open the resulting Enterprise Application, set **Assignment required?** to
   **Yes**, and assign approved users or groups. Suggested groups are
   `SG-Economic-AI-Readers` and `SG-Economic-AI-DraftCreators`.
6. Grant tenant admin consent for the delegated scope. Do not grant broad
   Microsoft Graph permissions; this API does not use Graph.

Redirect URIs belong on the MCP client registration or client configuration,
not normally on this resource API. Use the redirect URI required by the chosen
Claude/ChatGPT/client OAuth flow and register it exactly; do not use wildcards.

## Expected token

Obtain an access token for this API and inspect it with an approved local token
viewer. Do not paste production tokens into tickets or logs. The signed token
must have:

- `iss` for the configured tenant's v2.0 issuer;
- `tid` equal to `ENTRA_TENANT_ID`;
- `aud` equal to `ENTRA_API_CLIENT_ID`;
- `scp` containing `Mcp.Access`;
- `roles` containing one approved Economic role;
- valid `exp` and, when present, `nbf`.

Microsoft's access-token claims reference is
<https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference>
and its validation guidance is
<https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation>.
Stage 1 loads tenant-specific OpenID metadata and JWKS, restricts algorithms to
RS256, and supports Microsoft signing-key rotation.

## MCP discovery metadata

Set `MCP_PUBLIC_BASE_URL` to the clean public HTTPS origin. Verify:

```powershell
.\scripts\windows\test-entra.ps1 -Mode WellKnown -BaseUrl https://mcp.example.com
```

`/.well-known/oauth-protected-resource` returns the public resource identifier,
tenant authorization server, bearer method, and fully-qualified OAuth request
scope per RFC 9728:
<https://www.rfc-editor.org/rfc/rfc9728.html>.
The resource identifier is the exact Streamable HTTP endpoint
`<MCP_PUBLIC_BASE_URL>/mcp`. The server also exposes the path-specific discovery
alias `/.well-known/oauth-protected-resource/mcp` used by MCP clients as a
fallback.

## Authorization checks

Use short-lived test tokens from assigned accounts/groups:

```powershell
.\scripts\windows\test-entra.ps1 -Mode NoToken -BaseUrl https://mcp.example.com
.\scripts\windows\test-entra.ps1 -Mode Authenticated -BaseUrl https://mcp.example.com
.\scripts\windows\test-entra.ps1 -Mode ReaderWriteDenied -BaseUrl https://mcp.example.com
```

The script reads `ENTRA_TEST_ACCESS_TOKEN` only from the current process or
prompts with hidden input. Clear it after the test. Expected results are 401 for
no token, 200 for a valid scoped/role-bearing token, and 403 when a Reader token
requests a draft tool. Unit tests cover invalid signature, issuer, tenant,
audience, expiry, not-before/scope/role, and both role matrices without real
tokens.
