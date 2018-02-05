"use strict";

const https = require("https");
const url = require("url");
const AWS = require("aws-sdk");
const codepipeline = new AWS.CodePipeline();
const ssm = new AWS.SSM();

const TOKEN = new Promise((resolve, reject) => {
  console.log("Retrieving Quay API token from SSM Parameter Store");
  ssm.getParameters(
    {
      Names: ["quay-build-lambda-api-token"],
      WithDecryption: true
    },
    (err, data) => {
      if (err) {
        reject(err);
      } else if (data.InvalidParameters.length > 0) {
        console.log("Parameters were invalid: ");
        console.log(data.InvalidParameters);
        reject(new Error("SSM::InvalidParameterError"));
      } else {
        resolve(data.Parameters[0].Value);
      }
    }
  );
});

const httpsGetAll = request =>
  new Promise((resolve, reject) => {
    console.log("Sending API request to Quay");
    https
      .get(request, resp => {
        if (resp.statusCode == 200) {
          let data = "";
          resp.on("data", chunk => (data += chunk));
          resp.on("end", () => resolve(JSON.parse(data)));
        } else if (resp.statusCode == 301 || resp.statusCode == 302) {
          console.log("Following redirect");
          const redirect = url.parse(resp.headers.location);
          httpsGetAll({
            host: redirect.host,
            path: redirect.path,
            headers: request.headers
          }).then(redirectData => resolve(redirectData));
        } else {
          console.log("Got a bad status code");
          console.log(resp);
          reject(new Error(resp.statusMessage));
        }
      })
      .on("error", err => {
        console.log("Error while sending request!");
        reject(err);
      });
  });

const getQuayBuilds = data => {
  if (Array.isArray(data.builds)) {
    return data.builds;
  } else {
    console.log("Quay failed to respond with a list of builds");
    console.log(data);
    throw new Error("QuayError");
  }
};

const retryPhases = [
  "waiting",
  "internalerror",
  "build-scheduled",
  "unpacking",
  "pulling",
  "priming-cache",
  "building",
  "pushing"
];

const processQuayBuilds = (job, commit) => builds => {
  const callback = (err, data) => {
    if (err) {
      console.log("Error while trying to report to CodePipeline");
      throw err;
    } else {
      console.log("Successfully reported to CodePipeline");
    }
  };
  const build = builds.find(b => b.trigger_metadata.commit === commit);

  const continueJob = () =>
    codepipeline.putJobSuccessResult(
      {
        jobId: job.id,
        continuationToken: `token-${commit}`
      },
      callback
    );

  if (typeof build === "undefined") {
    console.log("Quay build not found, retrying.");
    continueJob();
  } else if (retryPhases.includes(build.phase)) {
    console.log(`Quay build is ${build.phase}, retrying.`);
    continueJob();
  } else if (build.phase === "complete") {
    console.log("Quay build is complete. Success!");
    codepipeline.putJobSuccessResult(
      {
        jobId: job.id
      },
      callback
    );
  } else {
    console.log(`Quay build is in an unexpected phase: ${build.phase}`);
    console.log(build);
    codepipeline.putJobFailureResult(
      {
        jobId: job.id,
        failureDetails: {
          type: "JobFailed",
          message: `Build failed due to unexpected build phase: ${build.phase}`,
          externalExecutionId: build.id
        }
      },
      callback
    );
  }
};

exports.lambdaHandler = function(event, context) {
  const job = event["CodePipeline.job"];
  const commit = job.data.inputArtifacts[0].revision;
  const repository = job.data.actionConfiguration.configuration.UserParameters;
  if (typeof repository === "undefined") {
    console.log("You must supply a repository name in the user parameters");
    throw new Error("NoRepository");
  }
  TOKEN.then(token => ({
    host: "quay.io",
    path: `/api/v1/repository/${repository}/build/`,
    headers: {
      Authorization: `Bearer ${token}`
    }
  }))
    .then(httpsGetAll)
    .then(getQuayBuilds)
    .then(processQuayBuilds(job, commit))
    .catch(e => {
      if (e.message) {
        console.log(`Caught error: ${e.message}`);
        if (e.stack) {
          console.log(e.stack);
        }
      } else {
        console.log("Caught a non-error object:");
        console.log(e);
      }
    });
};
