import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class AwsopsStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------
    // Parameters
    // -------------------------------------------------------
    const instanceType = new cdk.CfnParameter(this, 'InstanceType', {
      type: 'String',
      default: 't4g.2xlarge',
      allowedValues: [
        't4g.xlarge', 't4g.2xlarge',
        't3.large', 't3.xlarge', 't3.2xlarge',
        'm7g.xlarge', 'm7g.2xlarge',
        'm7i.xlarge', 'm7i.2xlarge',
      ],
      description: 'EC2 instance type for the AWSops server',
    });

    const vscodePassword = new cdk.CfnParameter(this, 'VSCodePassword', {
      type: 'String',
      noEcho: true,
      minLength: 8,
      description: 'Password for VSCode Server (minimum 8 characters)',
    });

    // 멀티 어카운트에서 대상 계정에 배포하는 읽기 전용 역할 이름
    // Name of the read-only role deployed in each target account (multi-account)
    const crossAccountRoleName = new cdk.CfnParameter(this, 'CrossAccountRoleName', {
      type: 'String',
      default: 'AWSopsReadOnlyRole',
      description: 'IAM role name deployed in target accounts for cross-account monitoring',
    });

    // 기존 VPC ID (빈 값이면 새 VPC 생성) / Existing VPC ID (empty = create new VPC)
    const existingVpcId = new cdk.CfnParameter(this, 'ExistingVpcId', {
      type: 'String',
      default: '',
      description: 'Existing VPC ID to use. Leave empty to create a new VPC.',
    });

    // -------------------------------------------------------
    // VPC: 기존 VPC 사용 또는 새로 생성 / Use existing or create new
    // -------------------------------------------------------

    // 기존 VPC 조회 또는 새 VPC 생성 / Lookup existing or create new
    const newVpcCidr = (this.node.tryGetContext('newVpcCidr') as string) || '10.10.0.0/16';
    if (this.node.tryGetContext('useExistingVpc') === 'true') {
      // 기존 VPC 사용 모드 / Use existing VPC mode
      const vpcId = this.node.tryGetContext('vpcId') || '';
      this.vpc = ec2.Vpc.fromLookup(this, 'VPC', { vpcId }) as unknown as ec2.Vpc;
    } else {
      // 새 VPC 생성 모드 / Create new VPC mode
      this.vpc = new ec2.Vpc(this, 'VPC', {
        ipAddresses: ec2.IpAddresses.cidr(newVpcCidr),
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: 'Public',
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            cidrMask: 24,
            name: 'Private',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
      });
      // 새 VPC에 이름 태그 / Tag new VPC with name
      cdk.Tags.of(this.vpc).add('Name', 'jaeho.p-vpc');
    }

    // -------------------------------------------------------
    // Transit Gateway Attachment (optional, both new and existing VPC)
    // -------------------------------------------------------
    const tgwId = this.node.tryGetContext('transitGatewayId') as string | undefined;
    if (tgwId) {
      const tgwAttachment = new ec2.CfnTransitGatewayAttachment(this, 'TGWAttachment', {
        transitGatewayId: tgwId,
        vpcId: this.vpc.vpcId,
        subnetIds: this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        tags: [{ key: 'Name', value: `${this.stackName}-TGW-Attachment` }],
      });

      // Multiple TGW route CIDRs (comma-separated) with backward compat
      const tgwRouteCidrsStr = (this.node.tryGetContext('tgwRouteCidrs') as string)
        || (this.node.tryGetContext('tgwRouteCidr') as string)
        || '';
      const tgwRouteCidrs = tgwRouteCidrsStr
        ? tgwRouteCidrsStr.split(',').map((c: string) => c.trim()).filter(Boolean)
        : [];

      tgwRouteCidrs.forEach((cidr: string, cidrIdx: number) => {
        this.vpc.privateSubnets.forEach((subnet, subnetIdx) => {
          const routeId = tgwRouteCidrs.length === 1
            ? `TGWRoute${subnetIdx}`
            : `TGWRoute-S${subnetIdx}-C${cidrIdx}`;
          new ec2.CfnRoute(this, routeId, {
            routeTableId: subnet.routeTable.routeTableId,
            destinationCidrBlock: cidr,
            transitGatewayId: tgwId,
          }).addDependency(tgwAttachment);
        });
      });

      new cdk.CfnOutput(this, 'TGWAttachmentId', {
        value: tgwAttachment.ref,
        description: 'Transit Gateway Attachment ID',
      });
    }

    // -------------------------------------------------------
    // Security Groups
    // -------------------------------------------------------

    // ALB SG: HTTPS(443) + HTTP(80, 443 리다이렉트용) 인터넷 허용
    // 인증은 ALB의 Cognito authenticate 액션이 담당 (SCP로 CloudFront 사용 불가)
    const albSg = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: 'awsops-alb-sg',
      description: 'AWSops ALB SG - HTTPS with Cognito auth',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect to HTTPS');

    // EC2 SG: ALB에서만 접근 허용 / Allow from ALB only
    const ec2Sg = new ec2.SecurityGroup(this, 'EC2SecurityGroup', {
      vpc: this.vpc,
      securityGroupName: 'awsops-ec2-sg',
      description: 'AWSops EC2 SG - ALB traffic only',
      allowAllOutbound: true,
    });
    // 8889 = nginx (/vscode 접두사 제거 후 code-server 8888로 중계)
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(8889), 'VSCode via nginx from ALB');
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(3000), 'Dashboard from ALB');

    // -------------------------------------------------------
    // SSM VPC Endpoints: skipVpcEndpoints=true이면 건너뜀
    // SSM VPC Endpoints: skip if context skipVpcEndpoints=true
    // 00-deploy-infra.sh에서 기존 VPC의 endpoint 존재 여부를 확인 후 context 전달
    // The deploy script checks if endpoints already exist and passes context
    // -------------------------------------------------------
    if (this.node.tryGetContext('skipVpcEndpoints') !== 'true') {
      const ssmSg = new ec2.SecurityGroup(this, 'SSMSecurityGroup', {
        vpc: this.vpc,
        description: 'SSM VPC Endpoints SG - HTTPS from VPC CIDR',
        allowAllOutbound: true,
      });
      // 기존 VPC는 CIDR이 다를 수 있으므로 0.0.0.0/0 대신 VPC CIDR 사용
      // Use VPC CIDR instead of hardcoded range for existing VPCs
      const vpcCidr = this.node.tryGetContext('useExistingVpc') === 'true'
        ? (this.node.tryGetContext('vpcCidr') || '10.0.0.0/8')
        : newVpcCidr;
      ssmSg.addIngressRule(ec2.Peer.ipv4(vpcCidr), ec2.Port.tcp(443), 'HTTPS from VPC CIDR');

      new ec2.InterfaceVpcEndpoint(this, 'SSMEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.SSM,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [ssmSg],
        privateDnsEnabled: true,
      });

      new ec2.InterfaceVpcEndpoint(this, 'SSMMessagesEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [ssmSg],
        privateDnsEnabled: true,
      });

      new ec2.InterfaceVpcEndpoint(this, 'EC2MessagesEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [ssmSg],
        privateDnsEnabled: true,
      });
    } // skipVpcEndpoints=true: 기존 endpoint 존재 시 건너뜀 / skip if already exist

    // -------------------------------------------------------
    // IAM Role for EC2 (SSM + CloudWatch)
    // -------------------------------------------------------
    // EC2 역할: SSM + CloudWatch + ReadOnlyAccess (Steampipe 필수)
    // EC2 Role: SSM + CloudWatch + ReadOnlyAccess (required for Steampipe)
    const ec2Role = new iam.Role(this, 'EC2Role', {
      roleName: 'awsops-ec2-role',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        // Steampipe가 AWS 리소스를 조회하려면 ReadOnlyAccess 필요
        // ReadOnlyAccess required for Steampipe to query AWS resources
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
      ],
      description: 'AWSops EC2 role - SSM, CloudWatch, ReadOnlyAccess for Steampipe',
    });

    // Bedrock model invoke permissions (AI assistant uses Sonnet/Opus 4.6 via global inference profiles)
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*:*:inference-profile/global.*',
        'arn:aws:bedrock:*::foundation-model/anthropic.*',
      ],
    }));

    // AgentCore 호출 권한 (설치 권한 아님 — 생성/삭제는 TempAgentCoreSetup으로 임시 부여)
    // AgentCore *invoke* permissions. Without these every AI request silently falls back
    // to plain Bedrock. Create/update/delete stay out of the instance role on purpose.
    ec2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreRuntimeAccess',
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:StopRuntimeSession',
        'bedrock-agentcore:StartCodeInterpreterSession',
        'bedrock-agentcore:InvokeCodeInterpreter',
        'bedrock-agentcore:StopCodeInterpreterSession',
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/awsops_agent-*`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:code-interpreter-custom/awsops_code_interpreter-*`,
      ],
    }));
    // /agentcore 상태 페이지가 쓰는 조회 API / read-only calls behind the /agentcore status page
    ec2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreReadStatus',
      actions: ['bedrock-agentcore:Get*', 'bedrock-agentcore:List*'],
      resources: ['*'],
    }));

    // S3 report upload (diagnosis report PPTX → awsops-deploy bucket)
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [`arn:aws:s3:::awsops-deploy-${this.account}/reports/*`],
    }));

    // EKS Access Entry management (register Steampipe read-only access to EKS clusters)
    // AssociateAccessPolicy requires access-entry resource, so use wildcard
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['eks:CreateAccessEntry', 'eks:AssociateAccessPolicy'],
      resources: ['*'],
    }));

    // 멀티 어카운트: 대상 계정의 읽기 전용 역할을 AssumeRole
    // Multi-account: assume the read-only role deployed in each target account
    // (infra-cdk/cfn-target-account-role.yaml — 역할 이름으로만 범위 제한)
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::*:role/${crossAccountRoleName.valueAsString}`],
    }));

    // Cognito 설정 + ALB 리스너에 인증 액션 부착 (05-setup-cognito.sh가 EC2에서 실행)
    // Cognito setup + attaching auth action to ALB listener (05-setup-cognito.sh runs on EC2)
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:*'],
      resources: ['*'],
    }));
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'elasticloadbalancing:ModifyListener',
        'elasticloadbalancing:ModifyRule',
      ],
      resources: ['*'],
    }));

    // 헬스 알림: 대시보드 헬스 프로브가 19개 도구 Lambda 를 호출 (scripts/14-setup-health-alerts.sh 와 동일)
    // Health alerts: dashboard health probe may invoke the 19 tool Lambdas (parity with scripts/14-setup-health-alerts.sh)
    const healthMonitorLambdas = [
      'awsops-network-mcp', 'awsops-reachability-analyzer', 'awsops-flow-monitor',
      'awsops-eks-mcp', 'awsops-ecs-mcp', 'awsops-iac-mcp', 'awsops-terraform-mcp',
      'awsops-iam-mcp', 'awsops-cloudwatch-mcp', 'awsops-cloudtrail-mcp', 'awsops-cost-mcp',
      'awsops-aws-knowledge', 'awsops-core-mcp', 'awsops-dynamodb-mcp', 'awsops-rds-mcp',
      'awsops-valkey-mcp', 'awsops-msk-mcp', 'awsops-steampipe-query', 'awsops-istio-mcp',
    ];
    ec2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'HealthMonitorProbe',
      actions: ['lambda:InvokeFunction'],
      resources: healthMonitorLambdas.map(
        (fn) => `arn:aws:lambda:${this.region}:${this.account}:function:${fn}`,
      ),
    }));

    // -------------------------------------------------------
    // EC2 Instance (Private Subnet, ARM64 Graviton by default)
    // -------------------------------------------------------
    // Determine AMI based on instance type (ARM64 for t4g/m7g, x86 otherwise)
    const al2023Arm64 = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });
    const al2023x86 = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.X86_64,
    });

    // UserData script for Node.js, Docker, Steampipe, code-server
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -euxo pipefail',
      'exec > >(tee /var/log/user-data.log) 2>&1',
      'echo "Starting user-data script at $(date)"',
      '',
      '# System update',
      'dnf update -y --allowerasing',
      'dnf install -y --allowerasing curl jq tar gzip python3 python3-pip',
      'pip3 install boto3 click bedrock-agentcore',
      '',
      '# Development tools (required for native npm modules)',
      'dnf groupinstall -y "Development Tools" || dnf install -y gcc gcc-c++ make || echo "[WARN] Dev tools install failed"',
      '',
      '# Node.js 20',
      'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - || true',
      'dnf install -y nodejs || true',
      'if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then',
      '  export HOME=/root',
      '  curl -fsSL https://fnm.vercel.app/install | bash',
      '  FNM_DIR="$(find /root/.local /.local -maxdepth 2 -name fnm -type f 2>/dev/null | head -1 | xargs dirname)"',
      '  export PATH="$FNM_DIR:$PATH"',
      '  eval "$(fnm env)"',
      '  fnm install 20 && fnm use 20',
      '  ln -sf "$(which node)" /usr/local/bin/node',
      '  ln -sf "$(which npm)" /usr/local/bin/npm',
      '  ln -sf "$(which npx)" /usr/local/bin/npx',
      'fi',
      'echo "Node.js version: $(node -v)"',
      '',
      '# AWS CLI v2',
      'ARCH=$(uname -m)',
      'if [ "$ARCH" = "aarch64" ]; then',
      '  curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o awscliv2.zip',
      'else',
      '  curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip',
      'fi',
      'unzip -q awscliv2.zip && ./aws/install && rm -rf aws awscliv2.zip',
      '',
      '# Docker',
      'dnf install -y docker',
      'systemctl enable docker && systemctl start docker',
      'usermod -aG docker ec2-user',
      '',
      '# kubectl',
      'if [ "$ARCH" = "aarch64" ]; then',
      '  curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/arm64/kubectl"',
      'else',
      '  curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"',
      'fi',
      'install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl && rm -f kubectl',
      '',
      '# Steampipe',
      '# Steampipe: install as root (/usr/local/bin requires root), plugins as ec2-user',
      'curl -fsSL https://steampipe.io/install/steampipe.sh | sh',
      'sudo -u ec2-user steampipe plugin install aws kubernetes trivy || true',
      '',
      '# code-server',
      'cd /tmp',
      'if [ "$ARCH" = "aarch64" ]; then',
      '  CS_PKG="code-server-4.106.3-linux-arm64"',
      'else',
      '  CS_PKG="code-server-4.106.3-linux-amd64"',
      'fi',
      'wget -q "https://github.com/coder/code-server/releases/download/v4.106.3/${CS_PKG}.tar.gz"',
      'tar -xzf "${CS_PKG}.tar.gz"',
      'mv "${CS_PKG}" /usr/local/lib/code-server',
      'ln -sf /usr/local/lib/code-server/bin/code-server /usr/local/bin/code-server',
      'rm -f "${CS_PKG}.tar.gz"',
      '',
      '# Configure code-server',
      'mkdir -p /home/ec2-user/.config/code-server',
      `cat > /home/ec2-user/.config/code-server/config.yaml <<CSEOF`,
      'bind-addr: 0.0.0.0:8888',
      'auth: password',
      `password: "${vscodePassword.valueAsString}"`,
      'cert: false',
      'CSEOF',
      'chown -R ec2-user:ec2-user /home/ec2-user/.config',
      '',
      '# code-server systemd service',
      'cat > /etc/systemd/system/code-server.service <<SVCEOF',
      '[Unit]',
      'Description=code-server',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'User=ec2-user',
      'WorkingDirectory=/home/ec2-user',
      `Environment="PASSWORD=${vscodePassword.valueAsString}"`,
      'ExecStart=/usr/local/bin/code-server --config /home/ec2-user/.config/code-server/config.yaml',
      'Restart=always',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SVCEOF',
      'systemctl daemon-reload && systemctl enable code-server && systemctl start code-server',
      '',
      // NOTE: user-data 문자열은 ASCII만 — CloudFormation이 비ASCII를 '?'로 저장해서
      //       매 배포마다 UserData 변경(=EC2 중단/교체)으로 잡힌다.
      // NOTE: keep user-data strings ASCII-only. CloudFormation stores non-ASCII as '?',
      //       so every later deploy sees a UserData change and interrupts/replaces the instance.
      '# nginx: strip the /vscode prefix and relay (ALB -> 8889 -> code-server 8888)',
      '# nginx path-stripping proxy for /vscode (ALB cannot strip path prefixes)',
      'dnf install -y nginx',
      "cat > /etc/nginx/conf.d/vscode-proxy.conf <<'NGEOF'",
      'server {',
      '    listen 8889;',
      '    # a redirect carrying port 8889 is unreachable from outside -> answer with relative paths',
      '    # Without these, redirects leak the internal port 8889 and time out externally',
      '    absolute_redirect off;',
      '    port_in_redirect off;',
      '    location = /vscode { return 301 /vscode/; }',
      '    location /vscode/ {',
      '        proxy_pass http://127.0.0.1:8888/;',
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Forwarded-Proto https;',
      '        proxy_set_header Upgrade $http_upgrade;',
      '        proxy_set_header Connection $http_connection;',
      '        proxy_set_header Accept-Encoding gzip;',
      '        proxy_read_timeout 3600s;',
      '        proxy_send_timeout 3600s;',
      '    }',
      '}',
      'NGEOF',
      'systemctl enable --now nginx',
      '',
      '# CloudWatch agent',
      'if [ "$ARCH" = "aarch64" ]; then',
      '  wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/arm64/latest/amazon-cloudwatch-agent.rpm || true',
      'else',
      '  wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm || true',
      'fi',
      '[ -f amazon-cloudwatch-agent.rpm ] && rpm -U ./amazon-cloudwatch-agent.rpm || true',
      'rm -f amazon-cloudwatch-agent.rpm',
      '',
      'echo "AWSops server setup completed at $(date)"',
    );

    // Use ARM64 AMI by default (t4g.2xlarge is ARM64 Graviton)
    this.instance = new ec2.Instance(this, 'AWSopsServer', {
      instanceName: 'awsops-server',
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: new ec2.InstanceType(instanceType.valueAsString),
      machineImage: al2023Arm64,
      securityGroup: ec2Sg,
      role: ec2Role,
      userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });
    cdk.Tags.of(this.instance).add('Name', `${this.stackName}-AWSops-Server`);
    cdk.Tags.of(this.instance).add('UserDataVersion', '2');

    // -------------------------------------------------------
    // Application Load Balancer (Internet-facing)
    // -------------------------------------------------------
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'PublicALB', {
      loadBalancerName: 'awsops-alb',
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: albSg,
      idleTimeout: cdk.Duration.seconds(3600),
    });
    cdk.Tags.of(this.alb).add('Name', 'awsops-alb');

    // -------------------------------------------------------
    // Custom Domain + ACM Certificate (HTTPS 필수 — ALB Cognito 인증 전제조건)
    // Usage: cdk deploy -c customDomain=awsops.dev1.musinsa.io
    // -------------------------------------------------------
    const customDomain = this.node.tryGetContext('customDomain') as string | undefined;
    if (!customDomain) {
      throw new Error('customDomain context is required (e.g. -c customDomain=awsops.dev1.musinsa.io) — ALB Cognito auth needs an HTTPS listener');
    }
    // 외부 DNS(Route 53 호스팅 존 없음): 미리 발급한 인증서 ARN을 넘기면 존 조회·인증서·A 레코드를 건너뛴다
    // External DNS (no Route 53 zone): -c certificateArn=arn:aws:acm:... skips zone lookup, cert and A record
    const certificateArn = this.node.tryGetContext('certificateArn') as string | undefined;
    let hostedZone: route53.IHostedZone | undefined;
    let certificate: acm.ICertificate;
    if (certificateArn) {
      certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn);
    } else {
      const hostedZoneNameCtx = this.node.tryGetContext('hostedZoneName') as string | undefined;
      // 'awsops.dev1.musinsa.io' → 'dev1.musinsa.io'
      const zoneName = hostedZoneNameCtx || customDomain.split('.').slice(1).join('.');
      hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: zoneName,
      });

      // ALB용 리전 인증서 (CloudFront 미사용 → us-east-1 불필요)
      certificate = new acm.Certificate(this, 'Certificate', {
        domainName: customDomain,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });
    }

    // nginx(8889)가 /vscode 접두사를 벗겨 code-server(8888)로 중계
    const vscodeTg = new elbv2.ApplicationTargetGroup(this, 'VSCodeProxyTargetGroup', {
      vpc: this.vpc,
      port: 8889,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        path: '/vscode/',
        port: '8889',
        healthyHttpCodes: '200,301,302',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      stickinessCookieDuration: cdk.Duration.days(1),
    });
    vscodeTg.addTarget(new elbv2_targets.InstanceTarget(this.instance, 8889));

    const dashboardTg = new elbv2.ApplicationTargetGroup(this, 'DashboardTargetGroup', {
      vpc: this.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        path: '/',
        port: '3000',
        healthyHttpCodes: '200,302',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      stickinessCookieDuration: cdk.Duration.days(1),
    });
    dashboardTg.addTarget(new elbv2_targets.InstanceTarget(this.instance, 3000));

    // -------------------------------------------------------
    // Listeners: 443 (HTTPS) — default: Dashboard(3000), /vscode*: nginx(8889)
    // 구 /awsops* 경로는 루트로 리다이렉트 (하위 호환)
    // Cognito authenticate 액션은 배포 후 05-setup-cognito.sh가 부착
    // -------------------------------------------------------
    const listener443 = this.alb.addListener('Listener443', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      open: false,
      defaultAction: elbv2.ListenerAction.forward([dashboardTg]),
    });

    listener443.addAction('VSCodeRule', {
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/vscode', '/vscode/*']),
      ],
      action: elbv2.ListenerAction.forward([vscodeTg]),
    });

    listener443.addAction('LegacyAwsopsRedirect', {
      priority: 20,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/awsops', '/awsops/*']),
      ],
      action: elbv2.ListenerAction.redirect({
        path: '/',
        permanent: false,
      }),
    });

    // Port 80: HTTPS 리다이렉트
    this.alb.addListener('Listener80', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // -------------------------------------------------------
    // Route 53 A record (alias) — 커스텀 도메인 → ALB
    // -------------------------------------------------------
    if (hostedZone) {
      new route53.ARecord(this, 'DomainARecord', {
        zone: hostedZone,
        recordName: customDomain,
        target: route53.RecordTarget.fromAlias(
          new route53targets.LoadBalancerTarget(this.alb),
        ),
      });
    }
    // 외부 DNS면 PublicALBEndpoint 출력값으로 CNAME을 직접 등록한다
    // With external DNS, point a CNAME at the PublicALBEndpoint output yourself

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'VPCId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: `${this.stackName}-VPC-ID`,
    });

    new cdk.CfnOutput(this, 'DashboardURL', {
      value: `https://${customDomain}/`,
      description: 'AWSops Dashboard URL',
      exportName: `${this.stackName}-Dashboard-URL`,
    });

    new cdk.CfnOutput(this, 'VSCodeURL', {
      value: `https://${customDomain}/vscode/`,
      description: 'VSCode (code-server) URL',
      exportName: `${this.stackName}-VSCode-URL`,
    });

    new cdk.CfnOutput(this, 'HttpsListenerArn', {
      value: listener443.listenerArn,
      description: 'ALB HTTPS listener ARN (Cognito auth attached by 05-setup-cognito.sh)',
      exportName: `${this.stackName}-Https-Listener-ARN`,
    });

    new cdk.CfnOutput(this, 'PublicALBEndpoint', {
      value: this.alb.loadBalancerDnsName,
      description: 'Public ALB DNS Name',
      exportName: `${this.stackName}-Public-ALB-DNS`,
    });

    new cdk.CfnOutput(this, 'InstanceId', {
      value: this.instance.instanceId,
      description: 'EC2 Instance ID',
      exportName: `${this.stackName}-Instance-ID`,
    });

    new cdk.CfnOutput(this, 'SSMAccess', {
      value: `aws ssm start-session --target ${this.instance.instanceId}`,
      description: 'SSM Session Manager access command',
    });
  }
}
