# Extra root certificates (company networks)

If the Jenkins build fails with `PKIX path building failed` or `unable to find valid certification path`, your
network inspects HTTPS (Zscaler, Netskope, a company proxy) and re-signs it with its own root certificate. Put that
root certificate here as a `.pem` or `.crt` file, then build again. Files here are git-ignored.

On a Mac the company root is in the System keychain; exporting all of it is fine (they are public certificates):

```bash
security find-certificate -a -p /Library/Keychains/System.keychain > sandbox/jenkins/certs/company.pem
docker compose -f sandbox/jenkins/docker-compose.yml down -v      # also drops the old CA bundle volume
docker compose -f sandbox/jenkins/docker-compose.yml up --build -d
```

Ask your IT team for the root certificate if it isn't there.
