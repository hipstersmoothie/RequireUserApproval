'use strict';

import * as core from '@actions/core';
import * as minimatch from 'minimatch';
import { Config, ConfigGroup } from './config';
import github from './github';

async function run() {
  core.info('Fetching configuration...');

  let config;

  try {
    config = await github.fetch_config();
  } catch (error: any) {
    if (error.status === 404) {
      core.warning('No configuration file is found in the base branch; terminating the process');
    }
    throw error;
  }

  core.debug("Config: ");
  core.debug(JSON.stringify(config, null, '\t'));

  core.info('Getting reviews...');
  let reviews = await github.get_reviews();

  let requirementCounts: { [group: string]: number } = {};
  let requirementMembers: { [group: string]: { [user: string]: boolean } } = {};
  core.debug('Retrieving required group configurations...');

  let { affected: affectedGroups, unaffected: unaffectedGroups } = identifyGroupsByChangedFiles(config, await github.fetch_changed_files());

  for (let req in affectedGroups) {
    core.debug(` - Group: ${req}`);
    if (affectedGroups[req].required == undefined) {
      core.warning(' - Group Required Count not specified, assuming 1 approver from group required.');
      affectedGroups[req].required = 1;
    } else {
      requirementCounts[req] = affectedGroups[req].required ?? 1;
    }
    requirementMembers[req] = {};
    core.debug(` - Requiring ${affectedGroups[req].required} of the following:`);
    for (let i in affectedGroups[req].members) {
      let member = affectedGroups[req].members[i];
      requirementMembers[req][member] = false;
      core.debug(`   - ${member}`);
    }
  }
  
  let reviewerState: { [group:string] : string } = {};

  core.debug('Getting most recent review for each reviewer...')
  for (let i = 0; i < reviews.length; i++) {
    let review = reviews[i];
    let userName = review.user.login;
    let state = review.state;
    reviewerState[userName] = state;
  }

  core.debug('Processing reviews...')
  for (let userName in reviewerState) {
    let state =  reviewerState[userName];
    if (state == 'APPROVED')
    {
      for (let group in requirementMembers) {
        for (let member in requirementMembers[group]) {
          if (member == userName) {
            requirementMembers[group][member] = true;
          }
        }
      }
    }
  }
  let failed = false;
  let failedGroups: string[] = [];
  core.debug('Checking for required reviewers...');

  for (let group in requirementMembers) {
    let groupApprovalRequired = requirementCounts[group];
    let groupMemberApprovals = requirementMembers[group];
    let groupApprovalCount = 0;
    let groupNotApprovedStrings: string[] = [];
    let groupApprovedStrings: string[] = [];
    for (let member in groupMemberApprovals) {
      if (groupMemberApprovals[member]) {
        groupApprovalCount++;
        groupApprovedStrings.push(member);
      }else {
        groupNotApprovedStrings.push(member);
      }
    }
    // await github.explainStatus(group, groupMemberApprovals, groupCountRequired);
    if (groupApprovalCount >= groupApprovalRequired) {
      //Enough Approvers
      core.startGroup(`We have all required approval(s) from group: ${group}.`);
      let appCount = 0;
      for (let approval in groupApprovedStrings) {
        core.info(`(${++appCount}/${groupApprovalRequired}) ✅ ${groupApprovedStrings[approval]}`);
      }
      for (let unapproval in groupNotApprovedStrings) {
        core.info(`(${appCount}/${groupApprovalRequired})   ${groupNotApprovedStrings[unapproval]}`);
      }
      core.endGroup();
    } else {
      failed = true;
      failedGroups.push(group);
      core.startGroup(`We have (${groupApprovalCount}/${groupApprovalRequired}) approval(s) from group: ${group}.`);
      let appCount = 0;
      for (let approval in groupApprovedStrings) {
        core.info(`(${++appCount}/${groupApprovalRequired}) ✅ ${groupApprovedStrings[approval]}`);
      }
      for (let unapproval in groupNotApprovedStrings) {
        core.info(`(${appCount}/${groupApprovalRequired}) ❌ ${groupNotApprovedStrings[unapproval]}`);
      }
      core.endGroup();
    }
  }
  if (failed) {
    core.setFailed(`Need approval from these groups: ${failedGroups.join(', ')}`);
  }
}

function identifyGroupsByChangedFiles(config: Config, changedFiles: string[]): { affected: ConfigGroup[], unaffected: ConfigGroup[] } {
  const affected: ConfigGroup[] = [];
  const unaffected: ConfigGroup[] = [];
  for (let groupName in config.groups) {
    const group = config.groups[groupName];
    const fileGlobs = group.paths;
    if (fileGlobs == null || fileGlobs == undefined || fileGlobs.length == 0)
    {
      core.warning(`No specific path globs assigned for group ${groupName}, assuming global approval.`);
      affected.push(group);
    }
    else if (fileGlobs.filter(glob => minimatch.match(changedFiles, glob, {nonull: false,matchBase: true}).length > 0).length > 0){
      affected.push(group);
    } else {
      unaffected.push(group);
    }
  }
  return { affected, unaffected };
}

module.exports = {
  run,
};

// Run the action if it's not running in an automated testing environment
if (process.env.NODE_ENV !== 'automated-testing') {
  run().catch((error) => {
    console.log(error);
    core.setFailed(error)
  });
}
