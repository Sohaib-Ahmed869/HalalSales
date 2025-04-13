const axios = require("axios");
const ScraperJob = require("../models/scraperJob");

// Configuration for the Python scraper API
const SCRAPER_API_URL =
  process.env.SCRAPER_API_URL || "http://127.0.0.1:5004/api";

/**
 * Start a new scraping job
 */
exports.startJob = async (req, res) => {
  try {
    const { region, scrolls = 10, getDetails = true, detailLimit } = req.body;

    // Validate required fields
    if (!region) {
      return res
        .status(400)
        .json({ success: false, message: "Region is required" });
    }

    // Request payload for Python API
    const payload = {
      region,
      scrolls,
      get_details: getDetails,
    };

    // Add detail_limit if provided
    if (detailLimit) {
      payload.detail_limit = detailLimit;
    }

    // Start the scraping job via Python API
    const response = await axios.post(`${SCRAPER_API_URL}/scrape`, payload);
    const jobData = response.data;

    // Create job record in MongoDB
    const newJob = new ScraperJob({
      jobId: jobData.job_id,
      region,
      status: "running",
      scrolls,
      getDetails,
      detailLimit,
      startTime: new Date(),
    });

    await newJob.save();

    return res.status(202).json({
      success: true,
      message: "Scraping job started successfully",
      job: {
        id: newJob._id,
        jobId: newJob.jobId,
        region: newJob.region,
        status: newJob.status,
      },
    });
  } catch (error) {
    console.error("Error starting scraper job:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to start scraping job",
      error: error.message,
    });
  }
};

/**
 * Get all scraping jobs
 */
exports.getJobs = async (req, res) => {
  try {
    // Query options
    const options = {
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 10,
      sort: { createdAt: -1 },
    };

    // Build query based on filters
    const query = {};

    if (req.query.status) {
      query.status = req.query.status;
    }

    if (req.query.region) {
      query.region = new RegExp(req.query.region, "i");
    }

    // Get jobs without restaurant data (for list view)
    const jobs = await ScraperJob.find(query, { restaurants: 0, rawData: 0 })
      .sort(options.sort)
      .skip((options.page - 1) * options.limit)
      .limit(options.limit);

    const total = await ScraperJob.countDocuments(query);

    return res.status(200).json({
      success: true,
      data: {
        jobs,
        pagination: {
          total,
          page: options.page,
          limit: options.limit,
          pages: Math.ceil(total / options.limit),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching scraper jobs:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch scraping jobs",
      error: error.message,
    });
  }
};

/**
 * Get a specific job by ID
 */
exports.getJobById = async (req, res) => {
  try {
    const { id } = req.params;

    // First try to find by MongoDB _id
    let job = await ScraperJob.findById(id);

    // If not found, try to find by jobId
    if (!job) {
      job = await ScraperJob.findOne({ jobId: id });
    }

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Scraping job not found",
      });
    }

    // Check if detailed results are requested
    const excludeResults = req.query.results === "false";

    // If job is running or pending, check with Python API for status updates
    if (job.status === "running" || job.status === "pending") {
      try {
        const statusResponse = await axios.get(
          `${SCRAPER_API_URL}/jobs/${job.jobId}`
        );
        const pythonStatus = statusResponse.data;

        // Update job status if changed
        if (pythonStatus.status && pythonStatus.status !== job.status) {
          job.status = mapPythonStatus(pythonStatus.status);

          // If completed, fetch the results
          if (job.status === "completed" && !excludeResults) {
            const resultsResponse = await axios.get(
              `${SCRAPER_API_URL}/results/${job.jobId}`
            );
            const resultsData = resultsResponse.data;

            // Update job with results data
            job.completionTime = new Date(resultsData.completion_time * 1000);
            job.restaurantCount = resultsData.count;
            job.restaurants = resultsData.data;
            job.rawData = resultsData;
          }

          // If failed or error, update error message
          if (job.status === "failed" || job.status === "error") {
            job.error = pythonStatus.error || "Unknown error occurred";
          }

          await job.save();
        }
      } catch (apiError) {
        console.error("Error fetching job status from Python API:", apiError);
        // Don't fail the request if Python API is down, just continue with DB data
      }
    }

    // Return job without large data fields if requested
    if (excludeResults) {
      const { restaurants, rawData, ...jobData } = job.toObject();
      return res.status(200).json({
        success: true,
        data: jobData,
      });
    }

    return res.status(200).json({
      success: true,
      data: job,
    });
  } catch (error) {
    console.error("Error fetching scraper job:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch scraping job",
      error: error.message,
    });
  }
};

/**
 * Sync job data with Python API
 */
exports.syncJob = async (req, res) => {
  try {
    const { id } = req.params;

    // Find the job
    let job = await ScraperJob.findOne({
      $or: [{ _id: id }, { jobId: id }],
    });

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Scraping job not found",
      });
    }

    // Get status from Python API
    const statusResponse = await axios.get(
      `${SCRAPER_API_URL}/jobs/${job.jobId}`
    );
    const pythonStatus = statusResponse.data;

    // Update status
    job.status = mapPythonStatus(pythonStatus.status);

    // If completed, get results
    if (job.status === "completed") {
      const resultsResponse = await axios.get(
        `${SCRAPER_API_URL}/results/${job.jobId}`
      );
      const resultsData = resultsResponse.data;

      job.completionTime = new Date(resultsData.completion_time * 1000);
      job.restaurantCount = resultsData.count;
      job.restaurants = resultsData.data;
      job.rawData = resultsData;
    } else if (job.status === "failed" || job.status === "error") {
      job.error = pythonStatus.error || "Unknown error occurred";
    }

    await job.save();

    return res.status(200).json({
      success: true,
      message: "Job synchronized successfully",
      data: job,
    });
  } catch (error) {
    console.error("Error syncing job:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to sync job with Python API",
      error: error.message,
    });
  }
};

/**
 * Delete a job
 */
exports.deleteJob = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await ScraperJob.findOneAndDelete({
      $or: [{ _id: id }, { jobId: id }],
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Scraping job not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Scraping job deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting job:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete scraping job",
      error: error.message,
    });
  }
};

/**
 * Get restaurants from a specific job
 */
exports.getRestaurants = async (req, res) => {
  try {
    const { id } = req.params;

    // Find the job
    const job = await ScraperJob.findOne({
      $or: [{ _id: id }, { jobId: id }],
    });

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Scraping job not found",
      });
    }

    if (job.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: `Cannot get restaurants; job status is ${job.status}`,
      });
    }

    // Pagination options
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    // Simple projection for restaurant list
    const restaurants = job.restaurants
      .slice((page - 1) * limit, page * limit)
      .map((r) => ({
        id: r.id,
        name: r.name,
        cuisine: r.cuisine,
        rating: r.rating,
        delivery_time: r.delivery_time,
        delivery_fee: r.delivery_fee,
        url: r.url,
        menuSize: r.menu ? r.menu.length : 0,
      }));

    return res.status(200).json({
      success: true,
      data: {
        restaurants,
        pagination: {
          total: job.restaurants.length,
          page,
          limit,
          pages: Math.ceil(job.restaurants.length / limit),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching restaurants:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch restaurants",
      error: error.message,
    });
  }
};

/**
 * Get a specific restaurant from a job
 */
exports.getRestaurantById = async (req, res) => {
  try {
    const { id, restaurantId } = req.params;

    // Find the job
    const job = await ScraperJob.findOne({
      $or: [{ _id: id }, { jobId: id }],
    });

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Scraping job not found",
      });
    }

    // Find restaurant in the job results
    const restaurant = job.restaurants.find((r) => r.id === restaurantId);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found in job results",
      });
    }

    return res.status(200).json({
      success: true,
      data: restaurant,
    });
  } catch (error) {
    console.error("Error fetching restaurant:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch restaurant",
      error: error.message,
    });
  }
};

/**
 * Get Python API health status
 */
exports.getApiStatus = async (req, res) => {
  try {
    const response = await axios.get(`${SCRAPER_API_URL}/health`);
    return res.status(200).json({
      success: true,
      status: "connected",
      pythonApi: response.data,
    });
  } catch (error) {
    return res.status(200).json({
      success: false,
      status: "disconnected",
      error: error.message,
    });
  }
};

/**
 * Helper function to map Python API status to our status values
 */
function mapPythonStatus(pythonStatus) {
  const statusMap = {
    started: "pending",
    running: "running",
    completed: "completed",
    failed: "failed",
    error: "error",
  };

  return statusMap[pythonStatus] || pythonStatus;
}
