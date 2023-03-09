import { Stack, StackProps, CfnParameter} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export class GrafanaForTwinMakerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    
    const grafanaAdminPassword = new CfnParameter(this, "grafanaAdminPassword", {
    type: "String",
    description: "Provide Admin password for Grafana"});
    
    const vpc = new ec2.Vpc(this, 'grafanaForTwinMakerVPC',
    {
      maxAzs: 2
    });

    const cluster = new ecs.Cluster(this, "ecsClusterForGrafana", {
      vpc: vpc
    });

    const efsFileSystem = new efs.FileSystem(this, 'EfsForGrafana', {
      vpc: vpc,
      encrypted: true
    });
    
    const accessPoint = new efs.AccessPoint(this, 'EfsAccessPoint', {
      fileSystem: efsFileSystem,
      path: '/grafana',
      posixUser: {
        gid: '0',
        uid: '472'
      },
      createAcl: {
        ownerGid: '0',
        ownerUid: '472',
        permissions: '755'
      }
    });
    
    const ecsVolume: ecs.Volume = {
      name: 'ecsVolume',
      efsVolumeConfiguration: {
        fileSystemId: efsFileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: accessPoint.accessPointId}
      },
    };
    
    const ecsTaskRole = new iam.Role(this, 'ecsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    ecsTaskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchReadOnlyAccess"))

    const ecsExecutionRole = new iam.Role(this, 'ecsExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    ecsExecutionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"))

    const datasourceRole = new iam.Role(this, 'datasourceRole', {
      assumedBy: ecsTaskRole,
    });

   const ecsTaskDefinition = new ecs.FargateTaskDefinition(this, "ecsForGrafanaTF",{
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole: ecsTaskRole,
      executionRole: ecsExecutionRole
    });
    
    ecsTaskDefinition.addVolume(ecsVolume);
    
    const logGroup = new logs.LogGroup(this, 'taskLogGroup', {
    });

    const logDriver = ecs.LogDrivers.awsLogs({
      streamPrefix: "grafanaForTwinMaker",
      logGroup: logGroup
    });

    const grafanaContainer = ecsTaskDefinition.addContainer("web", {
          image: ecs.ContainerImage.fromRegistry('grafana/grafana:latest'),
          logging: logDriver,
          environment: {
            GF_SECURITY_ADMIN_PASSWORD: grafanaAdminPassword.valueAsString,
            GF_INSTALL_PLUGINS: "grafana-iot-twinmaker-app"
          },
          portMappings: [{ containerPort: 3000 }],
        }
    );
    
    grafanaContainer.addMountPoints({
      sourceVolume: ecsVolume.name,
      containerPath: '/grafana',
      readOnly: false
    });
    
    const grafanaService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "GrafanaForTwinMakerService", {
      cluster: cluster, 
      taskDefinition: ecsTaskDefinition,
      desiredCount: 1
    });

    grafanaService.targetGroup.configureHealthCheck({
      path: '/api/health'
    });

    efsFileSystem.connections.allowDefaultPortFrom(grafanaService.service.connections);

  }
}
