import * as pulumi from "@pulumi/pulumi";
import { EnvironmentConfig } from "./types";

export function getEnvironmentConfig(environment: string): EnvironmentConfig {
    const config = new pulumi.Config();

    const baseConfig: EnvironmentConfig = {
        name: environment,
        region: config.get("aws:region") || "eu-west-3",
        tags: {
            Environment: environment,
            Project: "pulumi-aws-infrastructure",
            ManagedBy: "Pulumi",
            CostCenter: config.get("costCenter") || "development",
        },
    };

    // Environment-specific overrides
    switch (environment) {
        case "prod":
            return {
                ...baseConfig,
                tags: {
                    ...baseConfig.tags,
                    CostCenter: "production",
                    Backup: "required",
                },
            };
        case "staging":
            return {
                ...baseConfig,
                tags: {
                    ...baseConfig.tags,
                    CostCenter: "staging",
                    Backup: "optional",
                },
            };
        default:
            return baseConfig;
    }
}

export const commonTags = (environment: string) => {
    const config = getEnvironmentConfig(environment);
    return config.tags;
};
