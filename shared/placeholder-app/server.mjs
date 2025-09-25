import http from "node:http";

const port = process.env.PORT ? Number(process.env.PORT) : 8080;

const sendJson = (res, statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
};

const server = http.createServer((req, res) => {
    if (!req.url) {
        sendJson(res, 400, { message: "Invalid request" });
        return;
    }

    if (req.url === "/health") {
        sendJson(res, 200, { status: "healthy", timestamp: new Date().toISOString() });
        return;
    }

    sendJson(res, 200, {
        message: "Placeholder container seeded via Pulumi.",
        docs: "Replace this image by pushing your application tag to ECR.",
        timestamp: new Date().toISOString(),
    });
});

server.listen(port, () => {
    console.log(`Placeholder service listening on port ${port}`);
});
