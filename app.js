// Node packages being used. More info at https://www.npmjs.com/
const express = require("express");
const axios = require("axios"); // Sends HTTP requests

// Configuration of our server. More info at https://expressjs.com/
const app = express()
  .use(express.json())
  .use(express.urlencoded({ extended: true }));
const port = process.env.PORT || 3001;

// Integration variables
const PRODUCTBOARD_INTEGRATION_ID = "b4104ebb-c1c1-4bf7-939d-04b4126a4ed4"; // Plugin intgeration ID since created
const GITLAB_TOKEN = "glpat-ETvxAgaZygn4vnA3-m4T"; // Gitlab token to authorize HTTP Requests
const GITLAB_PROJECT_ID = "35858336"; // GitLab Project ID
const PRODUCTBOARD_TOKEN = // PB API token to authorize requests
  "Bearer eyJ0eXAiOiJKV1QiLCJraWQiOiJlY2IzMmI3MjdiNGY5NWFiOTkzNWNlMjhjYWViZGQ0MGRhYzIzMDk2YTJhZjliMDU1ZmJkZGEwOGM0ZmZiMzNmIiwiYWxnIjoiUlM1MTIifQ.eyJpc3MiOiJjNjU2YjMyNC04NmRjLTQ0ZWQtOWViNy1mMGYwMDEzMDhlMGEiLCJzdWIiOiI5NzEwMyIsInJvbGUiOiJhZG1pbiIsImF1ZCI6Imh0dHBzOi8vYXBpLnByb2R1Y3Rib2FyZC5jb20iLCJ1c2VyX2lkIjo5NzEwMywic3BhY2VfaWQiOiI1Nzc4MSIsImlhdCI6MTYzODIwNTEzN30.H4K0MNtRUeNLyClaEuHMp1UY8lUTgrR8QBfaVD8uyuEAtk9U-y9uuWb0m0CpJuLUm9bc3fSanFc8_-by9OgT2WERJT0UjgmH2RbXxN-te8tptsw2kdgbUqFNIMP2wqpXkIvwamdIwxtJP3Tj07BV0NpuoSGBLoppSNelg2yOWgOM9vtnrjHZx1V94lAJde9-bXo092wFaRMk8QcdTu-AyY-4Ao_x4h6p5d1Yzf1_L7qb7Royk7YhpAKySUK0B2noShlFzLu9roPnYwO8GT7EEFE5OtKco4sURYDXDULZbtyJE1Ztr_dY6W4PI9D2kssDo6cIYVK_AsoT51CWzvhKWw";

// Initial route to confirm app is running
app.get("/", (req, res) => {
  res.send("This is the service responsible for hosting our Productboard <> GitLab integration");
});

// Route to authenticate plugin connection. More info here: https://developer.productboard.com/#tag/pluginIntegrations
app.get("/plugin", (req, res) => {
  try {
    res.setHeader("Content-type", "text/plain");
    res.status(200).send(req.query.validationToken);
    console.log("Plugin integration created!");
  } catch (error) {
    console.log("Error when creating Plugin integration:", error);
  }
});

// Optional route if webhooks from Productboard are needed to support a 2-way sync
app.get("/productboard-webhook", async (req, res) => {
  res.setHeader("Content-type", "text/plain");
  res.status(200).send(req.query.validationToken);
});

// Endpoint where POST requests from Productboard plugin will be sent. More info here: https://developer.productboard.com/#operation/postPluginIntegration
app.post("/plugin", async (req, res) => {
  // Gather information about the Productboard feature that is sending over the request
  const pbFeatureID = req.body.data.feature.id;
  const pbFeatureLink = req.body.data.feature.links.html;

  console.log("Productboard trigger is:", req.body.data.trigger);

  // Determine action on button trigger. Can be push, dismiss, or unlink.
  if (req.body.data.trigger === "button.push") {
    res.json({
      data: {
        connection: {
          state: "progress",
        },
      },
    });

    // Get data about Productboard feature getting pushed
    getProductboardFeature(pbFeatureID)
      .then((pbFeatureResponse) => {
        // Extract data about Productboard feature
        const featureName = pbFeatureResponse.data.data.name;
        const featureDescription = pbFeatureResponse.data.data.description;
        const featureLinkHtml = `<br><strong>Click <a href="${pbFeatureLink}" target="_blank">here</a> to see feature in Productboard</strong>`;
        console.log(`Productboard feature name is: ${featureName}`);

        // Create issue in Gitlab
        createGitlabIssue(featureName, featureDescription + featureLinkHtml)
          .then((gitlabIssueResponse) => {
            // Extract data about Gitlab issue
            const issueID = gitlabIssueResponse.data.id;
            const issueURL = gitlabIssueResponse.data.web_url;
            console.log(`Gitlab issue ID is: ${issueID}`);

            // Connect feature and issue
            createProductboardPluginIntegrationConnection(pbFeatureID, issueID, issueURL)
              .then((response) => {
                console.log("Productboard feature connected to Gitlab issue.");
                console.log(response.data);
              })
              .catch((error) =>
                console.log("Error when connecting Productboard feature and Gitlab issue:", error)
              );
          })
          .catch((error) => console.log("Error when creating GitLab issue:", error));
      })
      .catch((error) => console.log("Error when getting Productboard feature:", error));
  } else {
    // If button trigger is unlink or dismiss, set PB plugin connection to initial state (basically disconnected)
    res.json({
      data: {
        connection: {
          state: "initial",
        },
      },
    });
    console.log("Productboard feature is unlinked");
  }

  res.status(200).end();
});

// Endpoint for requests from Gitlab for status updates in plugin integration column. More info here: https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#issue-events
app.post("/gitlab-webhook", async (req, _) => {
  // Extract information about the GitLab issue
  const gitlabIssueId = req.body.object_attributes.id;
  const gitlabIssueStatus = req.body.object_attributes.state;
  const gitlabIssueURL = req.body.object_attributes.url;

  console.log(`The Gitlab issue ID is: ${gitlabIssueId} and the state is: ${gitlabIssueStatus}`);
  let pbConnection = undefined;
  let pbLinksNext = true;
  let offset = 0;
  // List all plugin integrations connections
  while (pbConnection === undefined) {
    await getProductboardPluginIntegrationsConnections(offset)
      .then(async (pbConnectionsResponse) => {
        pbLinksNext = pbConnectionsResponse.data.links.next;
        console.log(pbConnectionsResponse.data.links.next);
        // Find the right plugin integration connection -> the tooltip must contain gitlab issue ID
        pbConnection = await pbConnectionsResponse.data.data.find((connection) =>
          connection.connection.tooltip?.includes(gitlabIssueId)
        );
        offset += 100;
        // Check if we found matching connection
        if (pbConnection) {
          console.log(`Connected Productboard feature ID is ${pbConnection.featureId}`);
          // Update the connection with new status
          updateProductboardPluginIntegrationConnection(
            pbConnection.featureId,
            gitlabIssueId,
            gitlabIssueStatus,
            gitlabIssueURL
          )
            .then((_) =>
              console.log(
                `Productboard plugin integration connection status is now: ${gitlabIssueStatus} 🚀`
              )
            )
            .catch((error) =>
              console.log("Error updating Productboard plugin integration connection", error)
            );
        }
      })

      .catch((error) =>
        console.log("Error getting Productboard plugin integrations connections:", error)
      );
    if (pbLinksNext === null) {
      break;
    }
  }
});

// Initiating server to listen for requests from PB and GitLab
app.listen(port, () => {
  console.log(`GitLab integration is listening on port http://localhost:${port}`);
});

// Get Productboard feature information
function getProductboardFeature(featureId) {
  return sendProductboardRequest("get", `features/${featureId}`);
}

// Create Productboard plugin connection. More info here: https://developer.productboard.com/#operation/postPluginIntegration
function createProductboardPluginIntegrationConnection(featureID, issueID, issueURL) {
  const pbPluginIntegrationData = JSON.stringify({
    data: {
      connection: {
        state: "connected",
        label: "Opened",
        hoverLabel: `Issue ${issueID}`,
        tooltip: `Issue ${issueID}`,
        color: "blue",
        targetUrl: issueURL,
      },
    },
  });

  return sendProductboardRequest(
    "put",
    `plugin-integrations/${PRODUCTBOARD_INTEGRATION_ID}/connections/${featureID}`,
    pbPluginIntegrationData
  );
}

// Get specific plugin integration data. More info here: https://developer.productboard.com/#operation/getPluginIntegrationConnection
async function getProductboardPluginIntegrationsConnections(offset) {
  return sendProductboardRequest(
    "get",
    `plugin-integrations/${PRODUCTBOARD_INTEGRATION_ID}/connections?pageLimit=100&pageOffset=${offset}`
  );
}

// Update a plugin integration connection. More info here: https://developer.productboard.com/#operation/putPluginIntegrationConnection
function updateProductboardPluginIntegrationConnection(featureID, issueID, issueStatus, issueURL) {
  const pbPluginIntegrationData = JSON.stringify({
    data: {
      connection: {
        state: "connected",
        label: issueStatus,
        hoverLabel: `Issue ${issueID}`,
        tooltip: `Issue ${issueID}`,
        color: issueStatus === "opened" ? "blue" : "green",
        targetUrl: issueURL,
      },
    },
  });

  return sendProductboardRequest(
    "put",
    `plugin-integrations/${PRODUCTBOARD_INTEGRATION_ID}/connections/${featureID}`,
    pbPluginIntegrationData
  );
}

// Structure for Axios requests sent to PB API. More info here: https://developer.productboard.com/#section/Introduction
function sendProductboardRequest(method, url, data = undefined) {
  return axios({
    method: method,
    url: `https://api.productboard.com/${url}`,
    headers: {
      "X-Version": "1",
      Authorization: PRODUCTBOARD_TOKEN,
      "Content-Type": "application/json",
    },
    data: data,
  });
}

// JSON data structure for creating GitLab issues. More info here: https://docs.gitlab.com/ee/api/issues.html#new-issue
function createGitlabIssue(title, description) {
  const gitlabIssueData = JSON.stringify({
    title: title,
    description: description,
  });

  return sendGitlabRequest("post", "issues", gitlabIssueData);
}

// Structure to send Axios requests to Gitlab API. More info here: https://docs.gitlab.com/ee/api/issues.html#new-issue
function sendGitlabRequest(method, url, data = undefined) {
  return axios({
    method: method,
    url: `https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/${url}`,
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "Content-Type": "application/json",
    },
    data: data,
  });
}
