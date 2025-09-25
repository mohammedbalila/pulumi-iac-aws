FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /app

RUN addgroup -g 1001 -S placeholder && \
    adduser -S placeholder -u 1001 -G placeholder

COPY server.mjs ./

RUN chown -R placeholder:placeholder /app

USER placeholder

EXPOSE 8080

CMD ["node", "server.mjs"]
