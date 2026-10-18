# A throwaway Jenkins to run qa-sentinel's Jenkinsfiles against the ShopLite sandbox (Docker Desktop on your laptop).
FROM jenkins/jenkins:lts-jdk21
USER root
# Company networks that inspect HTTPS (Zscaler, Netskope…) re-sign traffic with their own root certificate; Java,
# npm and git in here don't know it ("PKIX path building failed"). Put that root in certs/ (see certs/README.md):
# it is trusted by the OS, by Java (plugin downloads) and, through /qa-certs, by the pipeline's containers.
COPY certs/ /tmp/extra-certs/
RUN set -e; \
 for f in /tmp/extra-certs/*.pem /tmp/extra-certs/*.crt; do \
   [ -f "$f" ] || continue; \
   awk -v base="/usr/local/share/ca-certificates/extra-$(basename "$f" | tr -c 'A-Za-z0-9\n' _)" \
     '/BEGIN CERTIFICATE/{n++; out=base "-" n ".crt"} out{print > out} /END CERTIFICATE/{out=""}' "$f"; \
 done; \
 update-ca-certificates >/dev/null; \
 for c in /usr/local/share/ca-certificates/extra-*.crt; do \
   if [ -f "$c" ]; then keytool -importcert -noprompt -cacerts -storepass changeit -alias "$(basename "$c" .crt)" -file "$c" >/dev/null; fi; \
 done; \
 mkdir -p /qa-certs && cp /etc/ssl/certs/ca-certificates.crt /qa-certs/ca-bundle.pem && chmod 644 /qa-certs/ca-bundle.pem; \
 echo "extra root certificates: $(ls /usr/local/share/ca-certificates/ | grep -c '^extra-' || true)"; \
 rm -rf /tmp/extra-certs
# Docker CLI: the Jenkinsfiles run their stages in containers (agent { docker … }) through the host's Docker.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*
USER jenkins
COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli -f /usr/share/jenkins/ref/plugins.txt
COPY casc.yaml /usr/share/jenkins/ref/casc.yaml
ENV CASC_JENKINS_CONFIG=/usr/share/jenkins/ref/casc.yaml \
    JAVA_OPTS="-Djenkins.install.runSetupWizard=false -Dhudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT=true"
