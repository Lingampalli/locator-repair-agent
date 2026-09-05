// Manually triggered triage job.
//
// Trigger from the Jenkins UI after a smoke or regression run has finished.
// There is deliberately no build-status polling, no webhook and no scheduled
// sweep: a person deciding the run is complete is a more reliable barrier than
// a coordinator, because they know when a run was aborted or re-triggered.
//
// Put this link in the summary email — it loads on GET and shows the pre-filled
// form, so there is always a human confirmation step:
//
//   https://<JENKINS_URL>/job/locator-repair-triage/build?delay=0sec
//
// Do NOT use buildWithParameters in an email link: Jenkins requires POST for it
// under CSRF protection, so a plain GET link is rejected.

pipeline {
  agent { label '<EC2_NODE_LABEL>' }

  parameters {
    string(
      name: 'BUILD_NUMBERS',
      defaultValue: '',
      description: 'Master build number(s), comma-separated. Pass both smoke and regression together so one broken locator produces one PR, not two.'
    )
    choice(
      name: 'MODE',
      choices: ['report-only', 'propose-pr'],
      description: 'report-only produces the triage report and changes nothing. Stay here until the numbers justify moving.'
    )
    booleanParam(
      name: 'DRY_RUN',
      defaultValue: false,
      description: 'Run patch and verify, but do not create a branch or pull request.'
    )
    string(
      name: 'REPO_BRANCH',
      defaultValue: 'main',
      description: 'Branch of the test framework repository to triage against.'
    )
  }

  options {
    timestamps()
    timeout(time: 90, unit: 'MINUTES')
    disableConcurrentBuilds()
  }

  environment {
    EFS_ROOT         = '<EFS_ROOT>'
    BEDROCK_MODEL_ID = '<BEDROCK_MODEL_ID>'
    AWS_REGION       = '<AWS_REGION>'
    // Credentials come from Jenkins, never from the Dockerfile or this file.
    // AWS auth is the EC2 instance profile: no static keys anywhere.
    GITHUB_TOKEN     = credentials('<GITHUB_TOKEN_CREDENTIAL_ID>')
  }

  stages {
    stage('Checkout framework') {
      steps {
        dir('framework') {
          git url: '<FRAMEWORK_REPO_URL>', branch: params.REPO_BRANCH, credentialsId: '<GIT_CREDENTIAL_ID>'
        }
      }
    }

    stage('Checkout agent') {
      steps {
        dir('agent') {
          git url: '<AGENT_REPO_URL>', branch: 'main', credentialsId: '<GIT_CREDENTIAL_ID>'
          sh 'npm ci --no-audit --no-fund'
          sh 'npm run build'
        }
      }
    }

    stage('Confirm inputs') {
      steps {
        script {
          if (!params.BUILD_NUMBERS?.trim()) {
            error('BUILD_NUMBERS is required.')
          }
          echo """
            Builds : ${params.BUILD_NUMBERS}
            Mode   : ${params.MODE}
            Dry run: ${params.DRY_RUN}
            EFS    : ${env.EFS_ROOT}
          """.stripIndent()
        }
      }
    }

    stage('Triage') {
      steps {
        sh """
          node agent/dist/index.js \
            --builds '${params.BUILD_NUMBERS}' \
            --mode '${params.MODE}' \
            --efs-root '${env.EFS_ROOT}' \
            --repo-root "\$WORKSPACE/framework" \
            --out "\$WORKSPACE/triage-report.md" \
            ${params.DRY_RUN ? '--dry-run' : ''}
        """
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: 'triage-report.md', allowEmptyArchive: true
      // The summary email already has an audience. Sending the triage report
      // there means no new notification channel, and it makes the agent's
      // reasoning visible from day one — including in report-only mode.
      script {
        if (fileExists('triage-report.md')) {
          emailext(
            subject: "Locator triage — builds ${params.BUILD_NUMBERS} (${params.MODE})",
            body: readFile('triage-report.md'),
            mimeType: 'text/plain',
            to: '<QA_DISTRIBUTION_LIST>'
          )
        }
      }
    }
    cleanup {
      cleanWs()
    }
  }
}
