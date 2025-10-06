import { z } from "https://deno.land/x/zod@v3.20.0/mod.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import Papa from "npm:papaparse";
import ProgressBar from "https://deno.land/x/progress@v1.3.4/mod.ts";
import { encodeHex } from "https://deno.land/std@0.207.0/encoding/hex.ts";

type Package =  {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  date: string;
  links: {
    npm: string;
    homepage: string;
    repository: string;
    bugs: string;
  };
  publisher: {
    username: string;
    email: string;
  };
  maintainers: {
    username: string;
    email: string;
  }[];
};

type ResponseType = {
  objects: {
    package: Package;
    score: {
      final: number;
      detail: {
        quality: number;
        popularity: number;
        maintenance: number;
      };
    };
    searchScore: number;
  }[];
  total: number;
  time: string;
};


const LINE_PATTERN = /\r?\n/;

const IN_PATH = "data/in";
const OUT_PATH = "data/out";

const QUERIES_FILE_NAME = path.join(IN_PATH, "queries.txt");
const SENT_EMAILS_FILE_NAME = path.join(IN_PATH, "sent_emails.txt");

const PAGES_PER_QUERY = 40;

const queries: string[] = await fs.readFile(QUERIES_FILE_NAME, "utf8")
  .then((content: string) => content.split(LINE_PATTERN));

const sentEmails: string[] = await fs.readFile(SENT_EMAILS_FILE_NAME, "utf8")
  .then((content: string) => content.split(LINE_PATTERN));
console.log(`${sentEmails.length} emails sent`);

const sentEmailsSet = new Set<string>(sentEmails);

// https://stackoverflow.com/a/6234804/7589775
function escapeHTML(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildURL(index: number, query: string, max = 250) {
  if (max > 250) {
    throw new Error("Max > 250 - the registry can't handle more than this.");
  }

  // we can get a max of 250 at a time, sorting by popularity only, and using an empty search query (by abusing text filters and using a redundant boost-exact:false filter)
  return `https://registry.npmjs.com/-/v1/search?size=${max}&popularity=1.0&quality=0.0&maintenance=0.0&text=${query}&from=${index}`;
}

function pageURL(page: number, query: string) {
  return buildURL(page * 250, query);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPage(page: number, query: string, retries = 2): Promise<Package[]> {
  if (retries === 0) {
    throw new Error("retries over");
  }
  try {
    const request = await fetch(pageURL(page, query));
    // Add a delay between each call
    await wait(800);
    const response: ResponseType = await request.json();
    if (!response.objects) {
      throw new Error("No objects returned.");
    }

    return response.objects.map((obj) => obj.package);
  } catch (err) {
    // If an error occurred, likely because too many requests too fast, wait a bit then continue
    await wait(5000);
    console.log("retry", err);
    return getPage(page, query, retries - 1);
  }
}

const allPackagesSet = new Set<Package>();

async function getPackages(query: string) {
  console.log(`Fetching packages for query "${query}"...`);
  let completed = 0;

  const progress = Deno.isatty(Deno.stdout.rid)
    ? new ProgressBar({
      title: "Package progress:",
      total: PAGES_PER_QUERY,
    })
    : undefined;

  const packages: Package[] = [];
  for (let i = 0; i < PAGES_PER_QUERY; i++) {
    const fetchedPackages = await getPage(i, query);
    completed++;
    if (progress) {
      progress.render(completed);
    } else {
      console.log(`Completed ${completed} of ${PAGES_PER_QUERY} requests.`);
    }
    packages.push(...fetchedPackages);
  }
  return packages;
}

function getEmailsFromPackage(pkg: Package): string[] {
  const emails: string[] = [];
  if (pkg.publisher && pkg.publisher.email) {
    emails.push(pkg.publisher.email);
  }
  if (pkg.maintainers && Array.isArray(pkg.maintainers)) {
    emails.push(...pkg.maintainers.map((m) => m.email).filter(e => !!e));
  }
  return emails;
}

const newEmailsSet = new Set<string>();
for (const query of queries) {
  const packages = await getPackages(query);
  for (const pkg of packages) allPackagesSet.add(pkg);
  // Get the emails from each package
  // Filter out duplicates
  const newEmails: string[] = packages
    .flatMap((pkg) => getEmailsFromPackage(pkg))
    .filter((email, i, unfiltered) =>
      (unfiltered.indexOf(email) === i) && (!sentEmailsSet.has(email)) && (!newEmailsSet.has(email))
    );

  fs.writeFile(path.join(OUT_PATH, `${query}_new_emails.txt`), newEmails.join("\n"));
  for (const email of newEmails) newEmailsSet.add(email);
}

console.log(
  `Wrote ${newEmailsSet.size} new emails to ${queries.length} files in data/out`,
  `pulled from ${allPackagesSet.size} unique packages.`,
);

// if (packages.length !== 10000) {
// 	const remaining = 10000 - packages.length;
//
// 	const fetchURL = buildURL(packages.length, remaining);
//
// 	console.log(`Fetching remaining ${remaining} packages from ${fetchURL}...`);
//
// 	const request = await fetch(fetchURL);
//
// 	const { objects } = await request.json();
//
// 	packages.push(...objects.map((obj) => obj.package));
//
// 	console.log(`Fetched an extra ${objects.length} packages.`);
// }
//
// const packagesString = new TextEncoder().encode(JSON.stringify(allPackages));
// await Deno.writeFile("./raw.json", packagesString);
// await Deno.writeTextFile(
//   "./raw.json.hash",
//   encodeHex(await crypto.subtle.digest("SHA-256", packagesString)),
// );
//
// function optionallyFormat(arg: string | undefined, label: string): string {
//   if (!arg) {
//     return "";
//   }
//
//   return ` ([${label}](${arg}))`;
// }
//
// const mdContent = `# Packages
//
// Ordered list of top 10000 NPM packages:
//
// ${
//   allPackages.map((
//     { name, links: { npm, homepage, repository }, description, version },
//     i,
//   ) =>
//     `${i + 1}. [${name}](${npm})
//     - ${escapeHTML(description ?? "")}
//     - v${version} ${optionallyFormat(homepage, "homepage")}${
//       optionallyFormat(repository, "repository")
//     }`
//   ).join("\n")
// }
// `;
//
// await Deno.writeTextFile("./src/PACKAGES.md", mdContent);
//
// console.assert(
//   allPackages.length === 10000,
//   "Expected 10000 packages. Did the remainder function fail?",
// );
//
// console.log(
//   `Wrote ${allPackages.length} packages to ./raw.json and ./src/PACKAGES.md.`,
//   `with ${new Set(allPackages.map((pkg) => pkg.name)).size} unique packages.`,
// );
