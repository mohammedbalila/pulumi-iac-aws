// Application-wide constants
export const APPLICATION_CONSTANTS = {
    // Default values
    DEFAULT_APP_NAME: "my-app",
    DEFAULT_DB_USERNAME: "postgres",
    DEFAULT_GITHUB_ORG: "your-github-org",
    DEFAULT_GITHUB_REPO: "your-repo-name",

    // Configuration keys
    CONFIG_KEYS: {
        APP_NAME: "appName",
        DB_USERNAME: "dbUsername",
        DB_PASSWORD: "dbPassword",
        ALERT_EMAIL: "alertEmail",
        ENABLE_CLOUDFRONT: "enableCloudFront",
        ENABLE_WAF: "enableWaf",
        ENABLE_COST_BUDGET: "enableCostBudget",
        ENABLE_COST_ANOMALY: "enableCostAnomaly",
        GITHUB_ORG: "githubOrg",
        GITHUB_REPO: "githubRepo",
        ECR_IMAGE_URI: "ecrImageUri",
        USE_FCK_NAT: "useFckNat",
        API_BASE_URL: "apiBaseUrl",
        REDIS_URL: "redisUrl",
        SENTRY_DSN: "sentryDsn",
        ENABLE_NEW_FEATURE: "enableNewFeature",
    },

    // Environment variables
    ENV_VARS: {
        API_BASE_URL: "API_BASE_URL",
        LOG_LEVEL: "LOG_LEVEL",
        FEATURE_FLAGS: "FEATURE_FLAGS",
        DATABASE_URL: "DATABASE_URL",
        ENVIRONMENT: "ENVIRONMENT",
        REDIS_URL: "REDIS_URL",
        SENTRY_DSN: "SENTRY_DSN",
    },

    // Log levels
    LOG_LEVELS: {
        DEBUG: "debug",
        INFO: "info",
        WARN: "warn",
        ERROR: "error",
    },

    // Runtime environments
    RUNTIMES: {
        NODEJS_22: "nodejs22.x",
        NODEJS_20: "nodejs20.x",
        NODEJS_18: "nodejs18.x",
    },

    // Resource types
    RESOURCE_TYPES: {
        SECURITY_GROUP: "security-group",
        ECR_REPOSITORY: "ecr-repository",
        GITHUB_ACTIONS_ROLE: "github-actions-role",
        APP_RUNNER_SERVICE: "app-runner-service",
        LAMBDA_FUNCTION: "lambda-function",
        MONITORING: "monitoring",
        WAF: "waf",
        CLOUDFRONT: "cloudfront",
        BACKUP_ROLE: "backup-role",
        BACKUP_VAULT: "backup-vault",
        BACKUP_PLAN: "backup-plan",
    },
} as const;

// Database constants
export const DATABASE_CONSTANTS = {
    INSTANCE_CLASSES: {
        MICRO: "db.t3.micro",
        SMALL: "db.t4g.small",
        MEDIUM: "db.t4g.medium",
    },

    DEFAULT_STORAGE: {
        DEV: 20,
        STAGING: 20,
        PROD: 50,
    },

    MAX_STORAGE: {
        DEV: 20,
        STAGING: 50,
        PROD: 1000,
    },
} as const;

// App Runner constants
export const APP_RUNNER_CONSTANTS = {
    CPU_OPTIONS: {
        QUARTER: "0.25 vCPU",
        HALF: "0.5 vCPU",
        FULL: "1 vCPU",
        DOUBLE: "2 vCPU",
    },

    MEMORY_OPTIONS: {
        HALF_GB: "0.5 GB",
        ONE_GB: "1 GB",
        TWO_GB: "2 GB",
        FOUR_GB: "4 GB",
    },

    SCALING: {
        DEV: {
            MAX_CONCURRENCY: 10,
            MAX_SIZE: 2,
            MIN_SIZE: 1,
        },
        STAGING: {
            MAX_CONCURRENCY: 10,
            MAX_SIZE: 2,
            MIN_SIZE: 0,
        },
        PROD: {
            MAX_CONCURRENCY: 25,
            MAX_SIZE: 5,
            MIN_SIZE: 1,
        },
    },
} as const;

// ECR constants
export const ECR_CONSTANTS = {
    IMAGE_MUTABILITY: {
        MUTABLE: "MUTABLE",
        IMMUTABLE: "IMMUTABLE",
    },

    RETENTION_DAYS: {
        DEV: 7,
        STAGING: 14,
        PROD: 30,
    },
} as const;

// Networking constants
export const NETWORKING_CONSTANTS = {
    CIDR_BLOCKS: {
        DEV: "10.0.0.0/24",
        STAGING: "10.1.0.0/24",
        PROD: "10.2.0.0/24",
    },

    AVAILABILITY_ZONES: {
        DEV: 2,
        STAGING: 2, // Changed from 1 to match dev
        PROD: 2,
    },

    PORTS: {
        HTTP: 80,
        HTTPS: 443,
        ALL: 0,
    },

    PROTOCOLS: {
        ALL: "-1",
        TCP: "tcp",
        UDP: "udp",
    },
} as const;

// WAF constants
export const WAF_CONSTANTS = {
    RATE_LIMITS: {
        DEV: 1000,
        STAGING: 2000,
        PROD: 2000,
    },
} as const;

// CloudFront constants
export const CLOUDFRONT_CONSTANTS = {
    ORIGIN_CONFIG: {
        HTTP_PORT: 80,
        HTTPS_PORT: 443,
        ORIGIN_PROTOCOL_POLICY: "https-only",
        ORIGIN_SSL_PROTOCOLS: ["TLSv1.2"] as string[],
    },

    CACHE_BEHAVIOR: {
        VIEWER_PROTOCOL_POLICY: "redirect-to-https",
        ALLOWED_METHODS: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"] as string[],
        CACHED_METHODS: ["GET", "HEAD", "OPTIONS"] as string[],
        PRICE_CLASS: "PriceClass_All",
    },
};

// GitHub Actions constants
export const GITHUB_CONSTANTS = {
    BRANCHES: {
        DEV: ["develop"] as string[],
        STAGING: ["main"] as string[],
        PROD: ["main"] as string[],
    },
    ENVIRONMENTS: {
        DEV: ["dev"] as string[],
        STAGING: ["staging"] as string[],
        PROD: ["prod"] as string[],
    },
};

// Backup constants
export const BACKUP_CONSTANTS = {
    SCHEDULE: {
        DAILY: "cron(0 3 ? * * *)", // 3 AM UTC daily
    },

    WINDOWS: {
        START_WINDOW_MINUTES: 60,
        COMPLETION_WINDOW_MINUTES: 300,
    },

    LIFECYCLE: {
        COLD_STORAGE_AFTER_DAYS: 30,
        DELETE_AFTER_DAYS: 365,
    },
} as const;

// Feature flags constants
export const FEATURE_FLAGS = {
    DEV: {
        enableNewFeature: false,
        debugMode: true,
    },
    STAGING: {
        enableNewFeature: true,
        debugMode: false,
    },
    PROD: {
        enableNewFeature: false, // Configurable
        debugMode: false,
        enableAnalytics: true,
        enableCaching: true,
    },
} as const;
