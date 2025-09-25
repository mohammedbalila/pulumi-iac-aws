import * as pulumi from "@pulumi/pulumi";

export interface ConnectionStringArgs {
    username: pulumi.Input<string>;
    password: pulumi.Input<string>;
    host: pulumi.Input<string>;
    port: pulumi.Input<number>;
    database: pulumi.Input<string>;
    sslMode?: pulumi.Input<string>;
}

export const buildDatabaseConnectionString = (args: ConnectionStringArgs) => {
    const { username, password, host, port, database, sslMode } = args;

    return pulumi.secret(
        pulumi
            .all([username, password, host, port, database, sslMode])
            .apply(([user, pass, addr, dbPort, dbName, ssl]) => {
                const base = `postgresql://${user}:${pass}@${addr}:${dbPort}/${dbName}`;
                if (ssl === undefined || ssl === null || ssl === "") {
                    return base;
                }
                return `${base}?sslmode=${ssl}`;
            }),
    );
};
