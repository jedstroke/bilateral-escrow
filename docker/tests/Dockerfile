# Test runner: Node 22 plus su-exec, so the container can install dependencies as root and
# then run the tests as the host user (Linux only; see entrypoint.sh).
FROM node:22-alpine
RUN apk add --no-cache su-exec
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
WORKDIR /work/tests
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "test"]
